#!/usr/bin/env bash
# Claude Code statusLine
# JSON is parsed with `node` (jq is NOT installed on this system; node is
# guaranteed because Claude Code itself runs on it).
# Layout (left→right, volatile/important info leftmost so it survives truncation):
#   model  ef:effort  ctx%  5h%  [git branch/repo]  cwd
# Meters are threshold-colored. NOTE the opposite polarity:
#   ctx = context REMAINING (high = good)  |  5h = rate USED (high = bad)
node -e '
const fs = require("fs");
const cp = require("child_process");
let d = {};
try { d = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) {}

const home = process.env.HOME || "";
const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || "";
const cwdDisp = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

const model = (d.model && d.model.display_name) || "";

const repoObj = d.workspace && d.workspace.repo;
const repo = repoObj ? repoObj.owner + "/" + repoObj.name : "";
let branch = (d.worktree && d.worktree.branch) || "";
if (!branch && cwd) {
  try {
    branch = cp.execSync("git --no-optional-locks rev-parse --abbrev-ref HEAD",
      { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch (e) {}
}

const remaining = d.context_window && d.context_window.remaining_percentage;
const fiveH = d.rate_limits && d.rate_limits.five_hour && d.rate_limits.five_hour.used_percentage;

let effort = "";
try {
  const cfg = JSON.parse(fs.readFileSync(home + "/.claude/settings.json", "utf8"));
  effort = cfg.effortLevel || "";
} catch (e) {}

const paint = (code, s) => "\x1b[1;" + code + "m" + s + "\x1b[0m";
const remColor    = v => (v >= 50 ? 32 : v >= 20 ? 33 : 31);  // remaining: high good
const usedColor   = v => (v <= 50 ? 32 : v <= 80 ? 33 : 31);  // used: high bad
const effortColor = e => ({ low: 32, medium: 33, high: 35 }[e] || 37);  // low=green med=yellow high=magenta

const parts = [];
if (model) parts.push(paint(34, model));
if (effort) parts.push(paint(effortColor(effort), "ef:" + effort));
if (remaining != null && remaining !== "") {
  const r = Math.round(remaining);
  parts.push(paint(remColor(r), "ctx:" + r + "%"));
}
if (fiveH != null && fiveH !== "") {
  const u = Math.round(fiveH);
  parts.push(paint(usedColor(u), "5h:" + u + "%"));
}
const gitPart = [branch, repo].filter(Boolean).join(" ");
if (gitPart) parts.push(paint(32, "[" + gitPart + "]"));
if (cwdDisp) parts.push(paint(33, cwdDisp));

process.stdout.write(parts.join("  ") + "\n");
'
