const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Check a single sp_dc cookie
async function checkSpDc(spDc) {
  // Step 1: get access token
  const tokenRes = await fetch(
    "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
    {
      headers: {
        Cookie: `sp_dc=${spDc}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://open.spotify.com/",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "spotify-app-version": "1.2.31.364.g5f8a115c",
        "app-platform": "WebPlayer",
      },
    }
  );

  if (!tokenRes.ok) return { valid: false, reason: `token_${tokenRes.status}` };

  const tokenData = await tokenRes.json();
  if (tokenData.isAnonymous || !tokenData.accessToken) {
    return { valid: false, reason: "expired_or_invalid" };
  }

  const token = tokenData.accessToken;

  // Step 2: get user profile + plan
  const meRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!meRes.ok) return { valid: false, reason: `profile_${meRes.status}` };

  const me = await meRes.json();

  return {
    valid: true,
    email: me.email ?? "hidden",
    display_name: me.display_name ?? "",
    country: me.country ?? "",
    product: me.product ?? "unknown", // "premium" | "free" | "open"
    followers: me.followers?.total ?? 0,
    id: me.id ?? "",
  };
}

app.post("/api/check", async (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return res.status(400).json({ error: "No cookies provided" });
  }
  if (cookies.length > 100) {
    return res.status(400).json({ error: "Max 100 cookies per batch" });
  }

  const results = await Promise.allSettled(
    cookies.map(async (raw) => {
      const spDc = String(raw).trim();
      if (!spDc) return { spDc: "", valid: false, reason: "empty" };
      try {
        const result = await checkSpDc(spDc);
        return { spDc: spDc.slice(0, 12) + "…", ...result };
      } catch (err) {
        return { spDc: spDc.slice(0, 12) + "…", valid: false, reason: err.message };
      }
    })
  );

  res.json(results.map((r) => (r.status === "fulfilled" ? r.value : { valid: false, reason: r.reason?.message })));
});

app.listen(PORT, () => console.log(`Spotify Checker → http://localhost:${PORT}`));
