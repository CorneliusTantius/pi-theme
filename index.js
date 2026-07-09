import { AssistantMessageComponent, FooterComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const TOOL_PATCHED = Symbol.for("pi-theme:patched-tool-renderers");
const ASSISTANT_PATCHED = Symbol.for("pi-theme:patched-assistant-bubble");
const FOOTER_PATCHED = Symbol.for("pi-theme:patched-footer");
const PI_THEME = Symbol.for("@earendil-works/pi-coding-agent:theme");
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const MAX = 90;
const PAD = "    ";
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

function bg(theme, key, text) {
  try {
    return theme?.bg?.(key, text) ?? text;
  } catch {
    return text;
  }
}

function padRight(line, width) {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function assistantBubble(lines, width) {
  const theme = globalThis[PI_THEME];
  const innerWidth = Math.max(1, width - 2);
  const paint = (line = "") => bg(theme, "customMessageBg", padRight(line, width));
  return [
    ...lines.map((line) => paint(` ${truncateToWidth(line, innerWidth, "")}`)),
    paint(),
  ];
}

function splitLeadingThinking(lines) {
  const firstResponse = lines.findIndex((line) => stripAnsi(line).trim() && !isThinkingLine(trimLeft(line)));
  return firstResponse > 0 ? [lines.slice(0, firstResponse), lines.slice(firstResponse)] : [[], lines];
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
        .map((line) => PAD + truncateToWidth(trimLeft(line), innerWidth, ""));
    };
  }

  proto[TOOL_PATCHED] = true;
}

function hasThinkingContent(component) {
  return component?.lastMessage?.content?.some((item) => item?.type === "thinking" && item?.thinking?.trim());
}

function formatTokens(count) {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(count < 10000000 ? 1 : 0)}M`;
}

function usageStats(session) {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const entry of session.sessionManager.getEntries()) {
    const usage = entry?.type === "message" && entry.message?.role === "assistant" && entry.message.usage;
    if (!usage) continue;
    input += usage.input || 0;
    output += usage.output || 0;
    cost += usage.cost?.total || 0;
  }
  return [input && `↑${formatTokens(input)}`, output && `↓${formatTokens(output)}`, cost && `$${cost.toFixed(3)}`].filter(Boolean).join(" ");
}

function contextBar(session) {
  const theme = globalThis[PI_THEME];
  const usage = session.getContextUsage?.();
  const percent = usage?.percent ?? 0;
  const known = usage?.percent !== null && usage?.percent !== undefined;
  const width = 10;
  const used = known ? Math.round((Math.max(0, Math.min(100, percent)) / 100) * width) : 0;
  const color = percent > 90 ? "error" : percent > 70 ? "warning" : "success";
  const bar = `${fg(theme, color, "█".repeat(used))}${fg(theme, "dim", "░".repeat(width - used))}`;
  return `ctx ${fg(theme, "dim", "[")}${bar}${fg(theme, "dim", "]")} ${known ? `${percent.toFixed(1)}%` : "?%"}`;
}

function modelLabel(session) {
  const state = session.state;
  const model = state.model?.id || "no-model";
  return state.model?.reasoning && state.thinkingLevel && state.thinkingLevel !== "off" ? `${model} • ${state.thinkingLevel}` : model;
}

function footerStatsLine(session, width) {
  const left = [usageStats(session), contextBar(session)].filter(Boolean).join(" ");
  const right = modelLabel(session);
  const room = width - visibleWidth(left) - visibleWidth(right);
  if (room >= 2) return fg(globalThis[PI_THEME], "dim", left + " ".repeat(room) + right);
  return fg(globalThis[PI_THEME], "dim", truncateToWidth(`${left} ${right}`, width, ""));
}

function patchAssistant() {
  const proto = AssistantMessageComponent?.prototype;
  if (!proto || proto[ASSISTANT_PATCHED]) return;

  const originalRender = proto.render;
  if (typeof originalRender !== "function") return;

  proto.render = function renderAssistantBubble(width) {
    const bubbleWidth = Math.max(1, width - 2);
    const renderWidth = hasThinkingContent(this) ? Math.max(1, bubbleWidth - PAD.length) : bubbleWidth;

    if (this.hasToolCalls) {
      return originalRender.call(this, renderWidth).map((line) => truncateToWidth(padThinkingLine(line), width, ""));
    }

    const lines = trimBlank(originalRender.call(this, renderWidth))
      .filter((line) => !isFence(line))
      .map(cleanAssistantLine)
      .map((line) => truncateToWidth(line, bubbleWidth, ""));

    if (!lines.length) return lines;
    const [thinkingLines, responseLines] = splitLeadingThinking(lines);
    return responseLines.length ? [...thinkingLines, "", ...assistantBubble(responseLines, width)] : thinkingLines;
  };

  proto[ASSISTANT_PATCHED] = true;
}

function patchFooter() {
  const proto = FooterComponent?.prototype;
  if (!proto || proto[FOOTER_PATCHED]) return;

  const originalRender = proto.render;
  if (typeof originalRender !== "function") return;

  proto.render = function renderPiThemeFooter(width) {
    const lines = originalRender.call(this, width);
    try {
      if (lines.length > 1) lines[1] = truncateToWidth(footerStatsLine(this.session, width), width, "");
    } catch {
      return lines;
    }
    return lines;
  };

  proto[FOOTER_PATCHED] = true;
}

export default function piTheme() {
  patchTools();
  patchAssistant();
  patchFooter();
}
