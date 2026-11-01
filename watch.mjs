// watch.mjs — polls ATS career boards, pings Discord when a NEW matching job appears.
// Node 18+, zero dependencies. State lives in state/seen.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = "state/seen.json";

// ───────────── EDIT THIS: companies to watch ─────────────
// Slug = the bit in the careers URL:
//   boards.greenhouse.io/<slug>  or  job-boards.greenhouse.io/<slug>
//   job-boards.eu.greenhouse.io/<slug>  -> add eu: true
//   jobs.lever.co/<slug>    jobs.ashbyhq.com/<slug>
//   <tenant>.wd5.myworkdayjobs.com/<site>  -> host, tenant, site
// A wrong slug just prints ✗ in the log and gets skipped.
const COMPANIES = [
  // Greenhouse: the ones you asked for + boards I found while researching
  { name: "DigitalOcean", ats: "greenhouse", slug: "digitalocean98" },
  { name: "Razorpay", ats: "greenhouse", slug: "razorpaysoftwareprivatelimited" },
  { name: "Groww", ats: "greenhouse", slug: "groww", eu: true },
  { name: "Postman", ats: "greenhouse", slug: "postman" },
  { name: "Stripe", ats: "greenhouse", slug: "stripe" },
  { name: "Airbnb", ats: "greenhouse", slug: "airbnb" },
  { name: "Coinbase", ats: "greenhouse", slug: "coinbase" },
  { name: "Figma", ats: "greenhouse", slug: "figma" },
  { name: "Datadog", ats: "greenhouse", slug: "datadog" },
  { name: "GitLab", ats: "greenhouse", slug: "gitlab" },
  // Greenhouse: from my own knowledge, check the first run's log
  { name: "MongoDB", ats: "greenhouse", slug: "mongodb" },
  { name: "Cloudflare", ats: "greenhouse", slug: "cloudflare" },
  { name: "Anthropic", ats: "greenhouse", slug: "anthropic" },
  { name: "Databricks", ats: "greenhouse", slug: "databricks" },
  { name: "Twilio", ats: "greenhouse", slug: "twilio" },
  { name: "Okta", ats: "greenhouse", slug: "okta" },
  { name: "Elastic", ats: "greenhouse", slug: "elastic" },
  { name: "Pinterest", ats: "greenhouse", slug: "pinterest" },
  { name: "Dropbox", ats: "greenhouse", slug: "dropbox" },
  { name: "Robinhood", ats: "greenhouse", slug: "robinhood" },
  { name: "Affirm", ats: "greenhouse", slug: "affirm" },
  { name: "Samsara", ats: "greenhouse", slug: "samsara" },
  { name: "Rubrik", ats: "greenhouse", slug: "rubrik" },
  { name: "Vercel", ats: "greenhouse", slug: "vercel" },
  // Lever
  { name: "CRED", ats: "lever", slug: "cred" },
  { name: "Zeta", ats: "lever", slug: "zeta" },
  { name: "Palantir", ats: "lever", slug: "palantir" },
  // Ashby
  { name: "OpenAI", ats: "ashby", slug: "openai" },
  { name: "Ramp", ats: "ashby", slug: "ramp" },
  { name: "Notion", ats: "ashby", slug: "notion" },
  { name: "Perplexity", ats: "ashby", slug: "perplexity" },
  // Workday (shakiest: tenant/site names are from memory)
  { name: "PayPal", ats: "workday", host: "paypal.wd1.myworkdayjobs.com", tenant: "paypal", site: "jobs" },
  { name: "Adobe", ats: "workday", host: "adobe.wd5.myworkdayjobs.com", tenant: "adobe", site: "external_experienced" },
  { name: "Salesforce", ats: "workday", host: "salesforce.wd12.myworkdayjobs.com", tenant: "salesforce", site: "External_Career_Site" },
  { name: "Walmart", ats: "workday", host: "walmart.wd5.myworkdayjobs.com", tenant: "walmart", site: "WalmartExternal" },
];

// ───────────── EDIT THIS: what counts as a match ─────────────
// You search "software" on LinkedIn/Indeed, so "software" is the core term.
const TITLE_MATCH = /(software|full[- ]?stack|front[- ]?end|back[- ]?end|\bsde\b|developer|web engineer|platform engineer|react|node\.?js|typescript|golang)/i;
const TITLE_SKIP = /(intern|manager|director|head of|\bvp\b|staff|principal|sales|recruit|designer|marketing|data scientist|advocate|relations|evangelist|sdet|test engineer|support|hardware|firmware|embedded)/i;
const INDIA = /(india|bengaluru|bangalore|hyderabad|pune|mumbai|gurgaon|gurugram|noida|delhi|chennai|ahmedabad|kolkata|jaipur|surat)/i;
const REMOTE_OK = /(remote|anywhere|worldwide|global|apac)/i;
const REMOTE_NO = /(\bus\b|\busa\b|united states|canada|\buk\b|united kingdom|europe|emea|latam|germany|france|spain|ireland|australia|brazil|mexico|singapore|japan)/i;

// ───────────── fetchers: each returns [{id,title,location,url}] ─────────────
const fetchers = {
  async greenhouse(c) {
    const hosts = c.eu
      ? ["boards-api.eu.greenhouse.io", "boards-api.greenhouse.io"]
      : ["boards-api.greenhouse.io", "boards-api.eu.greenhouse.io"];
    const errs = [];
    for (const host of hosts) {
      try {
        const r = await getJson(`https://${host}/v1/boards/${c.slug}/jobs`);
        return r.jobs.map((j) => ({
          id: String(j.id),
          title: j.title,
          location: j.location?.name ?? "",
          url: j.absolute_url,
        }));
      } catch (e) {
        errs.push(e.message);
      }
    }
    throw new Error(errs.join(" | "));
  },

  async lever(c) {
    const r = await getJson(`https://api.lever.co/v0/postings/${c.slug}?mode=json`);
    return r.map((j) => ({
      id: j.id,
      title: j.text,
      location: j.categories?.location ?? "",
      url: j.hostedUrl,
    }));
  },

  async ashby(c) {
    const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${c.slug}`);
    return r.jobs.map((j) => ({
      id: j.id,
      title: j.title,
      location: j.location ?? "",
      url: j.jobUrl,
    }));
  },

  async workday(c) {
    const api = `https://${c.host}/wday/cxs/${c.tenant}/${c.site}/jobs`;
    const out = [];
    let total = Infinity;
    for (let offset = 0; offset < 300; offset += 20) {
      let r;
      try {
        r = await getJson(api, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: c.search ?? "software" }),
        });
      } catch (e) {
        if (offset === 0) throw e;
        break; // a later page failed: keep what we already have
      }
      if (offset === 0) total = r.total ?? Infinity; // Workday only reports total on page 1
      const posts = r.jobPostings ?? [];
      if (!posts.length) break;
      for (const p of posts) {
        out.push({
          id: p.externalPath,
          title: p.title,
          location: p.locationsText ?? "",
          url: `https://${c.host}/en-US/${c.site}${p.externalPath}`,
        });
      }
      if (out.length >= total) break;
    }
    return out;
  },
};

// ───────────── helpers ─────────────
async function getJson(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (job-watch)", ...opts.headers },
    });
  } catch (e) {
    throw new Error(`${e.cause?.code ?? e.cause?.message ?? e.message} ${url}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const locationOk = (l) =>
  !l ||
  /^\d+ locations?$/i.test(l) || // Workday multi-location: can't tell, let it through
  INDIA.test(l) ||
  (REMOTE_OK.test(l) && !REMOTE_NO.test(l));

const matches = (j) =>
  TITLE_MATCH.test(j.title) && !TITLE_SKIP.test(j.title) && locationOk(j.location);

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir("state", { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state));
}

async function notify(jobs) {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_URL is not set");
  for (let i = 0; i < jobs.length; i += 10) {
    const embeds = jobs.slice(i, i + 10).map((j) => ({
      title: `${j.company} — ${j.title}`.slice(0, 256),
      url: j.url,
      description: j.location || "Location not listed",
    }));
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: i === 0 ? `🚨 ${jobs.length} new job(s)` : undefined, embeds }),
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    await sleep(1000);
  }
}

// ───────────── main ─────────────
if (process.env.TEST_ALERT) {
  await notify([{ company: "Job watcher", title: "Test alert: Discord is connected", location: "New jobs will show up like this", url: "https://github.com" }]);
}

const state = await loadState();
const fresh = [];

const results = await Promise.allSettled(
  COMPANIES.map(async (c) => ({ c, jobs: await fetchers[c.ats](c) }))
);

results.forEach((r, i) => {
  if (r.status === "rejected") {
    console.error(`✗ ${COMPANIES[i].name}: ${r.reason.message}`);
    return;
  }
  const { c, jobs } = r.value;
  const isFirstRun = !(c.name in state); // first time we see a company: seed silently
  const known = new Set(state[c.name] ?? []);
  for (const j of jobs) {
    if (!isFirstRun && !known.has(j.id) && matches(j)) fresh.push({ company: c.name, ...j });
  }
  state[c.name] = [...new Set([...known, ...jobs.map((j) => j.id)])];
  console.log(`✓ ${c.name}: ${jobs.length} jobs${isFirstRun ? " (baseline saved)" : ""}`);
});

// Send first, save after: if Discord fails, nothing is marked seen and we retry next run.
if (fresh.length) await notify(fresh);
await saveState(state);
console.log(`Done. ${fresh.length} new matching job(s).`);
