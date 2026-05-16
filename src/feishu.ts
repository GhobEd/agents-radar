import fs from "node:fs";
import path from "node:path";
import { NOTIFY_LABELS } from "./i18n.ts";
import type { Highlights } from "./notify.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function resolvePagesUrl(): string {
  const configured = process.env["PAGES_URL"];
  if (configured) return configured.replace(/\/$/, "");

  const repository = process.env["GITHUB_REPOSITORY"];
  if (repository) {
    const [owner, repo] = repository.split("/", 2);
    if (owner && repo) return `https://${owner}.github.io/${repo}`;
  }

  return "https://duanyytop.github.io/agents-radar";
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  const json = (await res.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };

  if (!res.ok || json.code !== 0 || !json.tenant_access_token) {
    throw new Error(`Feishu auth failed: ${json.msg ?? res.statusText}`);
  }

  return json.tenant_access_token;
}

function buildFeishuText(
  date: string,
  reports: string[],
  highlights?: Highlights | null,
): string {
  const pagesUrl = resolvePagesUrl();
  const baseReports = reports.filter((r) => !r.endsWith("-en"));
  const zhHighlights = highlights?.zh ?? {};

  const lines: string[] = [`agents-radar ${date}`];

  for (const r of baseReports) {
    const zhLabel = NOTIFY_LABELS[r]?.zh ?? r;
    const zhUrl = `${pagesUrl}/#${date}/${r}`;
    const enKey = `${r}-en`;

    lines.push("");
    lines.push(`${zhLabel}: ${zhUrl}`);

    if (reports.includes(enKey)) {
      const enUrl = `${pagesUrl}/#${date}/${enKey}`;
      lines.push(`EN: ${enUrl}`);
    }

    const items = zhHighlights[r];
    if (items?.length) {
      for (const h of items) {
        lines.push(`- ${h}`);
      }
    }
  }

  lines.push("");
  lines.push(`Web UI: ${pagesUrl}`);
  lines.push(`RSS: ${pagesUrl}/feed.xml`);
  return lines.join("\n");
}

async function sendFeishu(text: string): Promise<void> {
  const appId = requireEnv("FEISHU_APP_ID");
  const appSecret = requireEnv("FEISHU_APP_SECRET");
  const chatId = requireEnv("FEISHU_CHAT_ID");

  const token = await getTenantAccessToken(appId, appSecret);

  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });

  const json = (await res.json()) as { code?: number; msg?: string };

  if (!res.ok || json.code !== 0) {
    throw new Error(`Feishu send failed: ${json.msg ?? res.statusText}`);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync("manifest.json")) {
    console.log("[feishu] manifest.json not found - skipping.");
    return;
  }

  const { dates } = JSON.parse(fs.readFileSync("manifest.json", "utf-8")) as {
    dates: { date: string; reports: string[] }[];
  };

  const latest = dates?.[0];
  if (!latest) {
    console.log("[feishu] manifest is empty - skipping.");
    return;
  }

  const { date, reports } = latest;

  let highlights: Highlights | null = null;
  const highlightsPath = path.join("digests", date, "highlights.json");
  if (fs.existsSync(highlightsPath)) {
    try {
      highlights = JSON.parse(fs.readFileSync(highlightsPath, "utf-8")) as Highlights;
    } catch {
      console.log("[feishu] Failed to parse highlights.json - sending without highlights.");
    }
  }

  const text = buildFeishuText(date, reports, highlights);
  console.log(`[feishu] Sending to chat ${process.env["FEISHU_CHAT_ID"]} for ${date}...`);
  await sendFeishu(text);
  console.log("[feishu] Done!");
}

main().catch((e: unknown) => {
  console.error("[feishu]", e instanceof Error ? e.message : e);
  process.exit(1);
});
