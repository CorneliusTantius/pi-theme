import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const TOOL_PATCHED = Symbol.for("pi-theme:patched-tool-renderers");
const ASSISTANT_PATCHED = Symbol.for("pi-theme:patched-assistant-bubble");
const PI_THEME = Symbol.for("@earendil-works/pi-coding-agent:theme");
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const MAX = 90;
const PAD = "      ";
const TRANSPARENT_BG = "\x1b[49m";
const TOOL_BG_KEYS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];

const clip = (value) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
};

function summarize(name, args = {}) {
  const tool = String(name || "").split(".").pop();
  switch (tool) {
    case "bash": return clip(args.command);
    case "read":
    case "write": return clip(args.path);
    case "edit": return clip(`${args.path || ""}${Array.isArray(args.edits) ? ` (${args.edits.length} edits)` : ""}`);
    case "grep": return clip([args.pattern && `"${args.pattern}"`, args.path && `in ${args.path}`].filter(Boolean).join(" "));
    case "find": return clip([args.pattern || "*", args.path && `in ${args.path}`].filter(Boolean).join(" "));
    case "ls": return clip(args.path || ".");
    case "agent_browser": return summarizeBrowser(args);
    case "parallel": return summarizeParallel(args);
    default: return clip(args.path || args.file_path || args.url || args.command || "");
  }
}

function summarizeBrowser(args = {}) {
  if (Array.isArray(args.args)) return clip(args.args.join(" "));
  if (args.semanticAction) return clip(Object.values(args.semanticAction).filter((v) => typeof v === "string").join(" "));
  if (args.job?.steps) return clip(`job ${args.job.steps.length} steps`);
  if (args.qa?.url) return clip(`qa ${args.qa.url}`);
  if (args.qa?.attached) return "qa attached";
  if (args.electron) return clip(`electron ${args.electron.action || ""} ${args.electron.appName || args.electron.bundleId || args.electron.appPath || ""}`);
  if (args.sourceLookup) return clip(`source ${args.sourceLookup.componentName || args.sourceLookup.selector || "lookup"}`);
  if (args.networkSourceLookup) return clip(`network ${args.networkSourceLookup.url || args.networkSourceLookup.filter || "lookup"}`);
  return "";
}

function summarizeParallel(args = {}) {
  const uses = args.tool_uses;
  return Array.isArray(uses) ? clip(`${uses.length} tools: ${uses.map((use) => use.recipient_name || use.name || "tool").join(", ")}`) : "";
}

function fg(theme, key, text) {
  return theme?.fg?.(key, text) ?? text;
}

function setBg(theme, key, value) {
  if (theme?.bgColors instanceof Map) theme.bgColors.set(key, value);
  else if (theme?.bgColors) theme.bgColors[key] = value;
}

function removeToolBackground(theme) {
  for (const target of [theme, globalThis[PI_THEME]]) {
    for (const key of TOOL_BG_KEYS) setBg(target, key, TRANSPARENT_BG);
  }
}

function statusFromContext(context) {
  if (context?.isError) return "error";
  return context?.isPartial === false ? "success" : "running";
}

function toolLine(theme, name, value, status) {
  removeToolBackground(theme);
  const color = status === "error" ? "error" : status === "running" ? "warning" : "success";
  const icon = status === "error" ? "✗" : status === "running" ? "›" : "✓";
  return new Text(`${fg(theme, color, icon)} ${fg(theme, color, name)}${value ? ` ${fg(theme, "dim", value)}` : ""}`, 0, 0);
}

function stripAnsi(line) {
  return String(line).replace(ANSI_RE, "");
}

function trimBlank(lines) {
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && !stripAnsi(lines[start]).trim()) start++;
  while (end >= start && !stripAnsi(lines[end]).trim()) end--;
  return lines.slice(start, end + 1);
}

function trimLeft(line) {
  return line.replace(/^((?:\x1b\[[0-9;]*m)*)\s+/, "$1");
}

function isFence(line) {
  return stripAnsi(line).trim().startsWith("```");
}

function cleanAssistantLine(line) {
  const leading = stripAnsi(line).match(/^\s*/)?.[0].length ?? 0;
  return padThinkingLine(leading <= 3 ? trimLeft(line) : line);
}

function padThinkingLine(line) {
  const cleaned = trimLeft(line);
  return isThinkingLine(cleaned) ? PAD + cleaned : line;
}

function isThinkingLine(line) {
  if (hasAnsiCode(line, 3)) return true;
  try {
    const ansi = globalThis[PI_THEME]?.getFgAnsi?.("thinkingText");
    return Boolean(ansi && line.includes(ansi));
  } catch {
    return false;
  }
}

function hasAnsiCode(line, code) {
  for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    if (match[1].split(";").map(Number).includes(code)) return true;
  }
  return false;
}

function separator(width) {
  return fg(globalThis[PI_THEME], "dim", truncateToWidth("─".repeat(width), width));
}

function patchTools() {
  const proto = ToolExecutionComponent?.prototype;
  if (!proto || proto[TOOL_PATCHED]) return;

  const originalHasRendererDefinition = proto.hasRendererDefinition;
  const originalRender = proto.render;

  proto.hasRendererDefinition = function hasRendererDefinition() {
    return Boolean(this?.toolName) || originalHasRendererDefinition?.call(this);
  };

  proto.getCallRenderer = function getCallRenderer() {
    return (args, theme, context) => toolLine(theme, this.toolName, summarize(this.toolName, args), statusFromContext(context));
  };

  proto.getResultRenderer = () => () => new Text("", 0, 0);

  if (typeof originalRender === "function") {
    proto.render = function renderCompactTool(width) {
      const innerWidth = Math.max(1, width - PAD.length);
      return trimBlank(originalRender.call(this, innerWidth))
        .map((line) => PAD + truncateToWidth(trimLeft(line), innerWidth));
    };
  }

  proto[TOOL_PATCHED] = true;
}

function patchAssistant() {
  const proto = AssistantMessageComponent?.prototype;
  if (!proto || proto[ASSISTANT_PATCHED]) return;

  const originalRender = proto.render;
  if (typeof originalRender !== "function") return;

  proto.render = function renderAssistantBubble(width) {
    if (this.hasToolCalls) {
      return originalRender.call(this, width).map((line) => truncateToWidth(padThinkingLine(line), width));
    }

    const lines = trimBlank(originalRender.call(this, width))
      .filter((line) => !isFence(line))
      .map(cleanAssistantLine)
      .map((line) => truncateToWidth(line, width));

    return lines.length ? [...lines, separator(width)] : lines;
  };

  proto[ASSISTANT_PATCHED] = true;
}

export default function piTheme() {
  patchTools();
  patchAssistant();
}
