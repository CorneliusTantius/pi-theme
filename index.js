import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const TOOL_PATCHED = Symbol.for("pi-theme:patched-tool-renderers");
const ASSISTANT_PATCHED = Symbol.for("pi-theme:patched-assistant-bubble");
const MAX = 90;
const PAD = "      ";
const BUBBLE_PAD = "";
const TRANSPARENT_BG = "\x1b[49m";
const PI_THEME = Symbol.for("@earendil-works/pi-coding-agent:theme");

function clip(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

function summarize(name, args = {}) {
  const tool = String(name || "").split(".").pop();
  if (tool === "bash") return clip(args.command);
  if (tool === "read") return clip(args.path);
  if (tool === "write") return clip(args.path);
  if (tool === "edit") return clip(`${args.path || ""}${Array.isArray(args.edits) ? ` (${args.edits.length} edits)` : ""}`);
  if (tool === "grep") return clip([args.pattern && `"${args.pattern}"`, args.path && `in ${args.path}`].filter(Boolean).join(" "));
  if (tool === "find") return clip([args.pattern || "*", args.path && `in ${args.path}`].filter(Boolean).join(" "));
  if (tool === "ls") return clip(args.path || ".");
  if (tool === "agent_browser") return summarizeBrowser(args);
  if (tool === "parallel") return summarizeParallel(args);
  return clip(args.path || args.file_path || args.url || args.command || "");
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
  if (!Array.isArray(uses)) return "";
  return clip(`${uses.length} tools: ${uses.map((use) => use.recipient_name || use.name || "tool").join(", ")}`);
}

function setBg(theme, key, value) {
  if (theme?.bgColors instanceof Map) theme.bgColors.set(key, value);
  else if (theme?.bgColors) theme.bgColors[key] = value;
}

function removeToolBackground(theme) {
  for (const target of [theme, globalThis[PI_THEME]]) {
    for (const key of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
      setBg(target, key, TRANSPARENT_BG);
    }
  }
}

function fg(theme, key, text) {
  return theme?.fg?.(key, text) ?? text;
}

function dim(text) {
  return fg(globalThis[PI_THEME], "dim", text);
}

function view(theme, name, value, status) {
  removeToolBackground(theme);
  const color = status === "error" ? "error" : status === "running" ? "warning" : "success";
  return new Text(`${fg(theme, color, name)}${value ? ` ${fg(theme, "dim", value)}` : ""}`, 0, 0);
}

function trimBlank(lines) {
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && !lines[start].replace(/\x1b\[[0-9;]*m/g, "").trim()) start++;
  while (end >= start && !lines[end].replace(/\x1b\[[0-9;]*m/g, "").trim()) end--;
  return lines.slice(start, end + 1);
}

function stripAnsi(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function trimLeft(line) {
  return line.replace(/^((?:\x1b\[[0-9;]*m)*)\s+/, "$1");
}

function isFence(line) {
  return stripAnsi(line).trim().startsWith("```");
}

function cleanAssistantLine(line) {
  const plain = stripAnsi(line);
  const leading = plain.match(/^\s*/)?.[0].length ?? 0;
  return leading <= 3 ? trimLeft(line) : line;
}

function rule(width, label = "") {
  const text = label ? `─ ${label} ` : "";
  return dim(truncateToWidth(`${text}${"─".repeat(width)}`, width));
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
    return (args, theme) => view(theme, this.toolName, summarize(this.toolName, args), "running");
  };

  proto.getResultRenderer = function getResultRenderer() {
    return () => new Text("", 0, 0);
  };

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
    if (this.hasToolCalls) return originalRender.call(this, width);

    const contentWidth = Math.max(1, width - BUBBLE_PAD.length);
    const lines = trimBlank(originalRender.call(this, contentWidth))
      .filter((line) => !isFence(line))
      .map(cleanAssistantLine);
    while (lines.length && !stripAnsi(lines[0]).trim()) lines.shift();
    const renderedLines = lines
      .map((line) => `${BUBBLE_PAD}${truncateToWidth(line, contentWidth)}`);
    if (!renderedLines.length) return renderedLines;

    return [
      ...renderedLines,
      `${BUBBLE_PAD}${rule(contentWidth)}`,
    ];
  };

  proto[ASSISTANT_PATCHED] = true;
}

export default function piTheme() {
  patchTools();
  patchAssistant();
}
