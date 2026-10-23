import assert from "node:assert/strict";
import test from "node:test";
import { fetchProfileData, parseContributionCalendar, renderProfileCard } from "./generate-profile-stats.mjs";

// Representative public GitHub calendar markup, with a year of dated cells.
const calendarHtml = Array.from({ length: 365 }, (_, index) => {
  const date = new Date(Date.UTC(2025, 9, 24) + index * 86_400_000).toISOString().slice(0, 10);
  return `<td id="day-${index}" data-date="${date}" class="ContributionCalendar-day" data-level="${index === 0 ? 4 : 0}"></td>
    <tool-tip for="day-${index}" class="sr-only">${index === 0 ? "1,234 contributions" : "No contributions"} on October 24th.</tool-tip>`;
}).join("\n");
const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("calendar uses actual dates, levels, and counts; rejects incomplete upstream markup", () => {
  const calendar = parseContributionCalendar(calendarHtml);
  assert.equal(calendar.days.length, 365);
  assert.equal(calendar.total, 1234);
  assert.deepEqual(calendar.days[0], { date: "2025-10-24", level: 4, count: 1234 });
  assert.equal(calendar.days.at(-1).date, "2026-10-23");
  assert.throws(() => parseContributionCalendar("<html>Unavailable</html>"), /incomplete/);
  assert.throws(() => parseContributionCalendar(calendarHtml.replace('for="day-1"', 'for="missing"')), /format changed/);
});

test("public fallback paginates all owned repos, includes collaborations once, and keeps all languages", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ full_name: `sample/repo-${index}` }));
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.startsWith("https://github.com/users/")) {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(calendarHtml);
    }
    assert.equal(options.headers.Authorization, "Bearer workflow-token");
    const path = new URL(url).pathname;
    if (path === "/users/sample/repos") return json(new URL(url).searchParams.get("page") === "1"
      ? firstPage : [{ full_name: "sample/last-page" }]);
    if (path === "/repos/team/collaboration") return json({ full_name: "team/collaboration" });
    if (path.endsWith("/languages")) return json(path.includes("last-page")
      ? { JavaScript: 100, Java: 100, HTML: 100, CSS: 100, "C#": 100, PowerShell: 1 }
      : path.includes("collaboration") ? { TypeScript: 100, Python: 100, GDScript: 100 } : {});
    assert.fail(`Unexpected request: ${url}`);
  };
  const data = await fetchProfileData({ username: "sample", githubToken: "workflow-token",
    additionalRepositories: ["team/collaboration", "TEAM/Collaboration", "sample/repo-0"], fetchImpl });
  assert.equal(data.repositoryCount, 102);
  assert.equal(data.privateInclusive, false);
  assert.equal(Object.keys(data.languageBytes).length, 9);
  assert.equal(data.languageBytes.PowerShell, 1);
  assert.equal(calls.filter((url) => url.endsWith("/languages")).length, 102);
  const svg = renderProfileCard(data, new Date("2026-10-23T18:00:00Z"));
  for (const name of Object.keys(data.languageBytes)) assert.ok(svg.includes(`>${name}</text>`), name);
  assert.ok(svg.includes("Updated 2026-10-24")); // Manila, regardless of runner timezone.
  assert.ok(svg.includes("9 languages / 102 public repos"));
  assert.ok(!svg.includes("team/collaboration"));
  // A full bar has no missing tail from omitted languages or artificially enlarged slivers.
  const segments = [...svg.matchAll(/<rect x="([\d.]+)" y="269" width="([\d.]+)" height="9" fill=/g)];
  assert.equal(segments.length, 9);
  assert.ok(Math.abs(segments.reduce((sum, segment) => sum + Number(segment[2]), 0) - 844) < .001);
  assert.equal((svg.match(/<title>\d+ contributions? on /g) || []).length, 365);
});

test("personal token discovers private and collaborator repos, deduplicates them, and protects repo names", async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/contributions")) return new Response(calendarHtml);
    if (path === "/user") return json({ login: "SAMPLE" });
    if (path === "/users/sample/repos") return json([{ full_name: "sample/public" }]);
    if (path === "/user/repos") {
      assert.equal(new URL(url).searchParams.get("affiliation"), "owner,collaborator,organization_member");
      return json([{ full_name: "sample/public" }, { full_name: "sample/secret-project" }, { full_name: "team/shared" }]);
    }
    if (path.endsWith("/languages")) return json(path.includes("secret-project") ? { GDScript: 20 } : { Python: 10 });
    assert.fail(`Unexpected request: ${url}`);
  };
  const data = await fetchProfileData({ username: "sample", statsToken: "personal-token", fetchImpl });
  assert.equal(data.repositoryCount, 3);
  assert.equal(data.languageBytes.GDScript, 20);
  assert.equal(data.languageBytes.Python, 20);
  const svg = renderProfileCard(data);
  assert.ok(svg.includes("3 accessible repos"));
  assert.ok(!svg.includes("secret-project"));
  assert.ok(!svg.includes("personal-token"));
});

test("a token for another account and API failures cannot publish misleading stats", async () => {
  await assert.rejects(fetchProfileData({ username: "sample", statsToken: "token", fetchImpl: async (url) =>
    json(new URL(url).pathname === "/user" ? { login: "someone-else" } : []) }), /must belong/);
  await assert.rejects(fetchProfileData({ username: "sample", fetchImpl: async () => new Response("Rate limited", { status: 403 }) }), /GitHub API 403/);
});
