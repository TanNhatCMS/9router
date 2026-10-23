import { existsSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch, version as osVersion } from "node:os";
import { join } from "node:path";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { readLocalZcodeJwt } from "../../executors/zcode-protocol.js";
import { parseResetTime } from "./shared.js";

// ZCode Start Plan quota — the same billing/balance endpoint the ZCode app uses.
// Auth is the shared zcode JWT from the local ZCode profile (no stored keys);
// the gateway only accepts requests carrying the app's identity header set.
const ZCODE_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const ZCODE_APP_VERSION = process.env.ZCODE_APP_VERSION || "3.16.2";

function readDeviceMid() {
  try {
    const file = join(homedir(), ".zcode", "v2", "telemetry-state.json");
    if (!existsSync(file)) return "";
    return JSON.parse(readFileSync(file, "utf8")).deviceMid || "";
  } catch {
    return "";
  }
}

function buildIdentityHeaders() {
  const osCategory = osPlatform() === "win32" ? "windows" : osPlatform();
  return {
    "User-Agent": `ZCode/${ZCODE_APP_VERSION}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": ZCODE_APP_VERSION,
    "X-Platform": `${osPlatform()}-${osArch()}`,
    "X-Release-Channel": process.env.ZCODE_RELEASE_CHANNEL || "production",
    "X-Client-Language": Intl.DateTimeFormat().resolvedOptions().locale,
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    "X-Os-Category": osCategory,
    "X-Os-Version": osVersion(),
    "X-Device-Mid": readDeviceMid(),
  };
}

export async function getZcodeUsage(ctx) {
  const jwt =
    ctx?.providerSpecificData?.zcodeJwtToken || ctx?.apiKey || ctx?.accessToken || readLocalZcodeJwt();
  if (!jwt) {
    return { message: "ZCode profile not found — log in to the ZCode app first." };
  }

  try {
    const response = await proxyAwareFetch(
      `${ZCODE_BALANCE_URL}?app_version=${encodeURIComponent(ZCODE_APP_VERSION)}`,
      {
        headers: {
          ...buildIdentityHeaders(),
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
        },
      },
      ctx?.proxyOptions ?? null,
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "ZCode session expired — re-login in the ZCode app." };
      }
      return { message: `ZCode balance API error (${response.status}).` };
    }

    const json = await response.json();
    if (json?.code !== 0) {
      return { message: json?.msg || `ZCode balance error (code ${json?.code}).` };
    }

    const data = json.data || {};
    const planName =
      (data.plans || []).find((plan) => plan?.status?.toLowerCase() === "active")?.name ||
      "ZCode Start Plan";

    // Bucket keys collide when two plans grant the same model (e.g. the daily
    // Start Plan bucket plus a referral bucket) — suffix the extras.
    const quotas = {};
    const seen = new Set();
    for (const bucket of data.balances || []) {
      const showName = bucket?.show_name?.trim();
      if (!showName) continue;
      let key = showName;
      let suffix = 2;
      while (seen.has(key)) key = `${showName} (${suffix++})`;
      seen.add(key);

      const total = Number(bucket.total_units) || 0;
      const used = Number(bucket.used_units) || 0;
      const remainingRaw = Number(bucket.remaining_units);
      const remaining = Number.isFinite(remainingRaw)
        ? Math.max(0, remainingRaw)
        : Math.max(0, total - used);
      quotas[key] = {
        used,
        total,
        remainingPercentage: total > 0 ? Math.round((remaining / total) * 100) : 0,
        resetAt: parseResetTime(bucket.expires_at ?? bucket.period_end),
        unlimited: false,
        unit: bucket.unit_type || "token",
      };
    }

    if (Object.keys(quotas).length === 0) {
      return { plan: planName, quotas, message: "No active Start Plan buckets found." };
    }

    return { plan: planName, quotas };
  } catch (error) {
    return { message: `ZCode error: ${error.message}` };
  }
}
