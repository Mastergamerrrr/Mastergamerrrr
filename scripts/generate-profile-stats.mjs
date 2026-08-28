import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const username =
  process.env.PROFILE_USERNAME ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "Mastergamerrrr";
const outputPath = process.env.OUTPUT_PATH || "assets/github-stats.svg";

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "profile-stats-generator",
  "X-GitHub-Api-Version": "2022-11-28",
};

if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${path}`);
  }

  return response.json();
}

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const formatNumber = (value) =>
  new Intl.NumberFormat("en", { notation: "compact" }).format(value);

const languageColors = {
  JavaScript: "#f1e05a",
  Java: "#b07219",
  "ASP.NET": "#512bd4",
  "C#": "#8b5cf6",
  GDScript: "#478cbf",
  CSS: "#563d7c",
  HTML: "#e34c26",
  GDShader: "#8da0cb",
  TypeScript: "#3178c6",
};

const [repositories, commitSearch] = await Promise.all([
  github(`/users/${encodeURIComponent(username)}/repos?per_page=100&type=owner`),
  github(`/search/commits?q=author%3A${encodeURIComponent(username)}`),
]);

const languageResults = await Promise.all(
  repositories.map((repository) => github(`/repos/${repository.full_name}/languages`)),
);

const languageBytes = new Map();
for (const result of languageResults) {
  for (const [language, bytes] of Object.entries(result)) {
    languageBytes.set(language, (languageBytes.get(language) || 0) + bytes);
  }
}

const totalLanguageBytes = [...languageBytes.values()].reduce(
  (sum, bytes) => sum + bytes,
  0,
);
const languages = [...languageBytes.entries()]
  .sort((left, right) => right[1] - left[1])
  .slice(0, 5)
  .map(([name, bytes]) => ({
    name,
    percent: totalLanguageBytes ? (bytes / totalLanguageBytes) * 100 : 0,
    color: languageColors[name] || "#58a6ff",
  }));

const projectRepositories = repositories.filter(
  (repository) => repository.name.toLowerCase() !== username.toLowerCase(),
).length;
const godotBuilds = languageResults.filter((languages) => languages.GDScript).length;
const metrics = [
  ["PUBLIC COMMITS", commitSearch.total_count],
  ["PROJECT REPOS", projectRepositories],
  ["CODE LANGUAGES", languageBytes.size],
  ["GODOT BUILDS", godotBuilds],
];

const metricMarkup = metrics
  .map(
    ([label, value], index) => `
      <g transform="translate(${42 + index * 205} 88)">
        <text class="value">${escapeXml(formatNumber(value))}</text>
        <text class="label" y="27">${escapeXml(label)}</text>
      </g>`,
  )
  .join("");

let barX = 42;
const barWidth = 816;
const barMarkup = languages
  .map((language) => {
    const width = (language.percent / 100) * barWidth;
    const segment = `<rect x="${barX.toFixed(1)}" y="191" width="${Math.max(width, 2).toFixed(1)}" height="9" fill="${language.color}" />`;
    barX += width;
    return segment;
  })
  .join("");

const legendMarkup = languages
  .map(
    (language, index) => `
      <g transform="translate(${42 + index * 162} 229)">
        <circle cx="5" cy="-4" r="5" fill="${language.color}" />
        <text class="legend" x="17">${escapeXml(language.name)}</text>
        <text class="percent" x="17" y="19">${language.percent.toFixed(1)}%</text>
      </g>`,
  )
  .join("");

const updated = new Date().toISOString().slice(0, 10);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="285" viewBox="0 0 900 285" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(username)} GitHub statistics</title>
  <desc id="description">Public commits, repositories, stars, followers, and most-used languages. Updated ${updated}.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d1117" />
      <stop offset="1" stop-color="#101b2d" />
    </linearGradient>
    <clipPath id="bar-clip"><rect x="42" y="191" width="816" height="9" rx="4.5" /></clipPath>
  </defs>
  <style>
    .eyebrow { fill: #58a6ff; font: 600 12px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1.4px; }
    .updated { fill: #7d8590; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .value { fill: #f0f6fc; font: 700 30px ui-sans-serif, system-ui, sans-serif; }
    .label { fill: #8b949e; font: 600 10px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .8px; }
    .section { fill: #c9d1d9; font: 600 12px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1px; }
    .legend { fill: #c9d1d9; font: 600 11px ui-sans-serif, system-ui, sans-serif; }
    .percent { fill: #7d8590; font: 10px ui-monospace, SFMono-Regular, Consolas, monospace; }
  </style>
  <rect x="1" y="1" width="898" height="283" rx="14" fill="url(#background)" stroke="#30363d" />
  <circle cx="855" cy="35" r="48" fill="#1f6feb" opacity=".08" />
  <text class="eyebrow" x="42" y="45">GITHUB / BUILD SIGNAL</text>
  <text class="updated" x="858" y="45" text-anchor="end">UPDATED ${updated}</text>
  ${metricMarkup}
  <line x1="42" y1="153" x2="858" y2="153" stroke="#30363d" />
  <text class="section" x="42" y="177">LANGUAGE FOOTPRINT</text>
  <g clip-path="url(#bar-clip)">${barMarkup}</g>
  ${legendMarkup}
</svg>`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${svg}\n`, "utf8");
console.log(`Updated ${outputPath} for ${username}.`);
