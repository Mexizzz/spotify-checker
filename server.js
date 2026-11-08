const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const OVERVIEW_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
};

const PROFILE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.5",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  Referer: "https://www.spotify.com/account/profile/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
};

function extract(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function inferPlan(name) {
  if (!name) return "unknown";
  const n = name.toLowerCase();
  if (n.includes("free")) return "free";
  if (n.includes("family") && n.includes("basic")) return "family_basic";
  if (n.includes("family")) return "family_premium";
  if (n.includes("duo")) return "duo_premium";
  if (n.includes("student") && n.includes("hulu")) return "student_hulu";
  if (n.includes("student")) return "student";
  if (n.includes("mini")) return "premium_mini";
  if (n.includes("premium")) return "premium";
  return "unknown";
}

function planLabel(key) {
  const map = {
    free: "Free",
    family_basic: "Family Basic",
    family_premium: "Family Premium",
    duo_premium: "Duo Premium",
    student_hulu: "Student + Hulu",
    student: "Student Premium",
    premium_mini: "Premium Mini",
    premium: "Premium",
    unknown: "Unknown",
  };
  return map[key] || key;
}

function parseOverview(html) {
  const src = html + html.replace(/\\"/g, '"').replace(/&quot;/g, '"');
  const loggedIn =
    src.includes('loggedIn\\":true') ||
    src.includes('"loggedIn":true') ||
    src.includes('"isLoggedInUser":true');

  const planName = extract(src, [
    /planName\\":\\"([^"]+)/,
    /"planName":"([^"]+)"/,
  ]);
  const country = extract(src, [
    /country\\":\\"([A-Za-z]{2})/,
    /"country":"([A-Za-z]{2})"/,
    /countryCode\\":\\"([A-Za-z]{2})/,
    /"countryCode":"([A-Za-z]{2})"/,
  ]);
  const email = extract(src, [/email\\":\\"([^"]+)/, /"email":"([^"]+)"/]);
  const isMaster = extract(src, [/isMaster\\":(true|false)/, /"isMaster":(true|false)/]);
  const isSubAcc = extract(src, [/isSubAccount\\":(true|false)/, /"isSubAccount":(true|false)/]);

  let isOwner = null;
  if (isMaster !== null) isOwner = isMaster === "true";
  else if (isSubAcc !== null) isOwner = isSubAcc === "false";

  return {
    loggedIn,
    planKey: inferPlan(planName || ""),
    planName: planName || "",
    country: country ? country.toUpperCase() : "",
    email: email || "",
    isOwner,
  };
}

// Build a cookie string from either sp_dc value or Netscape format
function buildCookieString(input) {
  const trimmed = input.trim();

  // Netscape cookie file (has tabs)
  if (trimmed.includes("\t")) {
    const pairs = [];
    for (const line of trimmed.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length >= 7) {
        pairs.push(`${parts[5]}=${parts[6]}`);
      }
    }
    return pairs.join("; ");
  }

  // JSON array of cookie objects
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr.map((c) => `${c.name}=${c.value}`).join("; ");
      }
    } catch {}
  }

  // Raw sp_dc value (no spaces, no tabs, no =)
  if (!trimmed.includes(";") && !trimmed.includes("=")) {
    return `sp_dc=${trimmed}`;
  }

  // Already a cookie string like "sp_dc=xxx; sp_key=yyy"
  return trimmed;
}

async function checkAccount(input) {
  const cookieStr = buildCookieString(input);
  if (!cookieStr) return { valid: false, reason: "empty" };

  const headers = { ...OVERVIEW_HEADERS, Cookie: cookieStr };

  const urls = [
    "https://www.spotify.com/us/account/overview/?utm_source=spotify&utm_medium=menu&utm_campaign=your_account",
    "https://www.spotify.com/account/overview/?utm_source=spotify&utm_medium=menu&utm_campaign=your_account",
  ];

  let overviewHtml = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 403 || r.status === 429) return { valid: false, reason: `overview_${r.status}` };
      if (r.status === 200) { overviewHtml = await r.text(); break; }
    } catch (e) {
      return { valid: false, reason: "network_error" };
    }
  }

  if (!overviewHtml) return { valid: false, reason: "no_response" };

  const parsed = parseOverview(overviewHtml);
  if (!parsed.loggedIn) return { valid: false, reason: "not_logged_in" };

  // Try to enrich email/country from profile API
  try {
    const pr = await fetch("https://www.spotify.com/api/account-settings/v1/profile", {
      headers: { ...PROFILE_HEADERS, Cookie: cookieStr },
      redirect: "manual",
    });
    if (pr.status === 200) {
      const pj = await pr.json();
      const prof = pj.profile || pj;
      if (prof.email) parsed.email = prof.email;
      if (prof.country) parsed.country = String(prof.country).toUpperCase();
    }
  } catch {}

  return {
    valid: true,
    plan: planLabel(parsed.planKey),
    planKey: parsed.planKey,
    email: parsed.email || "hidden",
    country: parsed.country || "?",
    isOwner: parsed.isOwner,
  };
}

app.post("/api/check", async (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies) || cookies.length === 0)
    return res.status(400).json({ error: "No cookies provided" });
  if (cookies.length > 100)
    return res.status(400).json({ error: "Max 100 per batch" });

  const results = await Promise.allSettled(
    cookies.map(async (raw, i) => {
      const input = String(raw).trim();
      if (!input) return { input: "", valid: false, reason: "empty" };
      try {
        const result = await checkAccount(input);
        const preview = input.length > 16 ? input.slice(0, 16) + "…" : input;
        return { input: preview, ...result };
      } catch (e) {
        return { input: input.slice(0, 16) + "…", valid: false, reason: e.message };
      }
    })
  );

  res.json(results.map((r) => (r.status === "fulfilled" ? r.value : { valid: false, reason: "internal_error" })));
});

app.listen(PORT, () => console.log(`Spotify Checker → http://localhost:${PORT}`));
