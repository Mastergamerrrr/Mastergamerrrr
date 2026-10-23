import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const languageColors = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572a5",
  Java: "#b07219", "ASP.NET": "#9400ff", "C#": "#178600",
  GDScript: "#355570", GDShader: "#478cbf", CSS: "#663399",
  HTML: "#e34c26", PowerShell: "#012456", C: "#555555",
  "C++": "#f34b7d", SQL: "#e38c00",
};
const contributionColors = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];
const dayMs = 86_400_000;
const isoDate = (date) => date.toISOString().slice(0, 10);
const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

// The public calendar matches the profile chart, including anonymized private
// activity when the user has enabled it. Never send API credentials to this URL.
export function parseContributionCalendar(html) {
  const tooltips = new Map();
  for (const match of html.matchAll(/<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/g)) {
    const id = match[1].match(/\bfor="([^"]+)"/)?.[1];
    const count = match[2].replace(/<[^>]+>/g, "").trim()
      .match(/^(No|[\d,]+) contributions? on /)?.[1];
    if (id && count) tooltips.set(id, count === "No" ? 0 : Number(count.replaceAll(",", "")));
  }
  const days = [];
  for (const match of html.matchAll(/<td\b[^>]*>/g)) {
    const attributes = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)]
      .map((attribute) => [attribute[1], attribute[2]]));
    if (!attributes["data-date"]) continue;
    const count = tooltips.get(attributes.id);
    const level = Number(attributes["data-level"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(attributes["data-date"]) ||
        !Number.isInteger(level) || level < 0 || level > 4 || count === undefined) {
      throw new Error("GitHub contribution calendar format changed; keeping the previous card.");
    }
    days.push({ date: attributes["data-date"], level, count });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  // Reject incomplete or duplicate calendars rather than publishing missing activity.
  if (days.length < 365 || days.length > 371 || days.some((day, index) =>
    index > 0 && Date.parse(day.date) - Date.parse(days[index - 1].date) !== dayMs)) {
    throw new Error("GitHub returned an incomplete contribution calendar; keeping the previous card.");
  }
  return { days, total: days.reduce((sum, day) => sum + day.count, 0) };
}

export async function fetchProfileData({
  username, statsToken, githubToken, additionalRepositories = [], fetchImpl = fetch,
}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "profile-stats-generator",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (statsToken || githubToken) headers.Authorization = `Bearer ${statsToken || githubToken}`;
  async function github(path) {
    const response = await fetchImpl(`https://api.github.com${path}`, { headers });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path}`);
    return response.json();
  }
  async function paginate(path) {
    const results = [];
    for (let page = 1; ; page++) {
      const batch = await github(`${path}&per_page=100&page=${page}`);
      results.push(...batch);
      if (batch.length < 100) return results;
    }
  }

  const repositories = await paginate(`/users/${encodeURIComponent(username)}/repos?type=owner`);
  if (statsToken) {
    const viewer = await github("/user");
    if (viewer.login.toLowerCase() !== username.toLowerCase()) {
      throw new Error("PROFILE_STATS_TOKEN must belong to PROFILE_USERNAME.");
    }
    repositories.push(...await paginate("/user/repos?visibility=all&affiliation=owner,collaborator,organization_member"));
  }
  // Keep known public collaborations in the fallback as well. Do not put private
  // repository names in this config or in generated output.
  const names = new Set(repositories.map((repo) => repo.full_name.toLowerCase()));
  for (const name of additionalRepositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error("Invalid additional repository name.");
    if (!names.has(name.toLowerCase())) {
      repositories.push(await github(`/repos/${name}`));
      names.add(name.toLowerCase());
    }
  }
  const uniqueRepositories = [...new Map(repositories.map((repo) =>
    [repo.full_name.toLowerCase(), repo])).values()];
  const languageBytes = new Map();
  // Bounded requests avoid bursts as the repository collection grows.
  for (let index = 0; index < uniqueRepositories.length; index += 5) {
    const results = await Promise.all(uniqueRepositories.slice(index, index + 5)
      .map((repo) => github(`/repos/${repo.full_name}/languages`)));
    for (const result of results) {
      for (const [name, bytes] of Object.entries(result)) {
        if (bytes > 0) languageBytes.set(name, (languageBytes.get(name) || 0) + bytes);
      }
    }
  }
  const response = await fetchImpl(`https://github.com/users/${encodeURIComponent(username)}/contributions`, {
    headers: { "User-Agent": "profile-stats-generator" },
  });
  if (!response.ok) throw new Error(`GitHub calendar HTTP ${response.status}`);
  return {
    username,
    calendar: parseContributionCalendar(await response.text()),
    repositoryCount: uniqueRepositories.length,
    privateInclusive: Boolean(statsToken),
    languageBytes: Object.fromEntries(languageBytes),
  };
}

export function renderProfileCard(data, now = new Date()) {
  const { username, calendar, repositoryCount, privateInclusive, languageBytes } = data;
  const totalBytes = Object.values(languageBytes).reduce((sum, bytes) => sum + bytes, 0);
  const languages = Object.entries(languageBytes).sort((a, b) => b[1] - a[1])
    .map(([name, bytes]) => ({ name, percent: bytes / totalBytes * 100, color: languageColors[name] || "#8b949e" }));
  const width = 900;
  const columns = 4;
  const height = 314 + Math.max(1, Math.ceil(languages.length / columns)) * 42;
  const firstDay = Date.parse(calendar.days[0].date);
  const firstSunday = firstDay - new Date(firstDay).getUTCDay() * dayMs;
  const weekCount = Math.floor((Date.parse(calendar.days.at(-1).date) - firstSunday) / (7 * dayMs)) + 1;
  const step = Math.min(14.8, 780 / weekCount);
  const cellSize = step - 3;
  const graphX = 68;
  const graphY = 74;
  const monthLabels = [];
  const monthFormat = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
  let lastLabelWeek = -4;
  for (let week = 0; week < weekCount; week++) {
    const date = new Date(firstSunday + week * 7 * dayMs);
    const previousWeek = new Date(date.getTime() - 7 * dayMs);
    if ((week === 0 || date.getUTCMonth() !== previousWeek.getUTCMonth()) && week - lastLabelWeek >= 2) {
      monthLabels.push(`<text class="label" x="${(graphX + week * step).toFixed(2)}" y="64">${monthFormat.format(date)}</text>`);
      lastLabelWeek = week;
    }
  }
  const cells = calendar.days.map((day) => {
    const date = Date.parse(day.date);
    const week = Math.floor((date - firstSunday) / (7 * dayMs));
    return `<rect x="${(graphX + week * step).toFixed(2)}" y="${(graphY + new Date(date).getUTCDay() * step).toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" rx="2" fill="${contributionColors[day.level]}"><title>${day.count} contribution${day.count === 1 ? "" : "s"} on ${day.date}</title></rect>`;
  }).join("\n    ");
  let barX = 28;
  const bar = languages.map((language) => {
    const segmentWidth = language.percent / 100 * 844;
    const markup = `<rect x="${barX.toFixed(4)}" y="269" width="${segmentWidth.toFixed(4)}" height="9" fill="${language.color}"><title>${escapeXml(language.name)}: ${language.percent.toFixed(2)}%</title></rect>`;
    barX += segmentWidth;
    return markup;
  }).join("");
  const legend = languages.map((language, index) => {
    const percent = language.percent < 0.1 ? "&lt;0.1" : language.percent.toFixed(1);
    return `<g transform="translate(${28 + index % columns * 211} ${307 + Math.floor(index / columns) * 42})">
      <circle cx="5" cy="-4" r="4.5" fill="${language.color}" />
      <text class="language" x="17">${escapeXml(language.name)}</text>
      <text class="muted percent" x="17" y="16">${percent}%</text>
    </g>`;
  }).join("\n    ");
  const updated = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(username)}'s contributions and language footprint</title>
  <desc id="description">${calendar.total} contributions from ${calendar.days[0].date} to ${calendar.days.at(-1).date}. ${languages.length} languages across ${repositoryCount} ${privateInclusive ? "accessible" : "public"} repositories, including collaborations. Languages: ${languages.map((language) => escapeXml(language.name)).join(", ")}. Updated ${updated}.</desc>
  <defs><clipPath id="language-bar"><rect x="28" y="269" width="844" height="9" rx="4.5" /></clipPath></defs>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #c9d1d9; }
    .heading { font-size: 14px; font-weight: 600; }
    .label { font-size: 11px; }
    .muted { fill: #8b949e; font-size: 11px; }
    .section { font-size: 12px; font-weight: 600; letter-spacing: .6px; }
    .language { font-size: 12px; font-weight: 500; }
    .percent { font-size: 10px; }
  </style>
  <rect x=".5" y=".5" width="899" height="${height - 1}" rx="8" fill="#0d1117" stroke="#30363d" />
  <text class="heading" x="28" y="31">${calendar.total.toLocaleString("en")} contributions in the last year</text>
  <text class="muted" x="872" y="31" text-anchor="end">Updated ${updated}</text>
  ${monthLabels.join("\n  ")}
  ${[["Mon", 1], ["Wed", 3], ["Fri", 5]].map(([name, day]) => `<text class="label" x="54" y="${(graphY + day * step + cellSize - 1).toFixed(2)}" text-anchor="end">${name}</text>`).join("\n  ")}
  <g>${cells}</g>
  <text class="muted" x="28" y="202">Daily contributions on GitHub</text>
  <text class="muted" x="737" y="202" text-anchor="end">Less</text>
  ${contributionColors.map((color, index) => `<rect x="${746 + index * 15}" y="191" width="12" height="12" rx="2" fill="${color}" />`).join("")}
  <text class="muted" x="827" y="202">More</text>
  <line x1="28" y1="226" x2="872" y2="226" stroke="#30363d" />
  <text class="section" x="28" y="251">LANGUAGE FOOTPRINT</text>
  <text class="muted" x="872" y="251" text-anchor="end">${languages.length} languages / ${repositoryCount} ${privateInclusive ? "accessible" : "public"} repos</text>
  <g clip-path="url(#language-bar)">${bar}</g>
  ${legend || '<text class="muted" x="28" y="307">No language data reported by GitHub.</text>'}
</svg>\n`;
}

async function main() {
  const username = process.env.PROFILE_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "Mastergamerrrr";
  const outputPath = process.env.OUTPUT_PATH || "assets/github-stats.svg";
  const config = JSON.parse(await readFile(new URL("../.github/profile-stats.json", import.meta.url), "utf8"));
  const data = await fetchProfileData({ username, statsToken: process.env.PROFILE_STATS_TOKEN,
    githubToken: process.env.GITHUB_TOKEN, additionalRepositories: config.additionalRepositories });
  const svg = renderProfileCard(data);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, svg, "utf8");
  console.log(`Updated ${outputPath}: ${data.repositoryCount} repositories, ${Object.keys(data.languageBytes).length} languages.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
