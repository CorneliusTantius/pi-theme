import { AssistantMessageComponent, CustomEditor, FooterComponent, InteractiveMode, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const TOOL_PATCHED = Symbol.for("pi-theme:patched-tool-renderers");
const ASSISTANT_PATCHED = Symbol.for("pi-theme:patched-assistant-bubble");
const FOOTER_PATCHED = Symbol.for("pi-theme:patched-footer");
const STATUS_PATCHED = Symbol.for("pi-theme:patched-status");
const INPUT_PATCHED = Symbol.for("pi-theme:patched-input");
const USER_PATCHED = Symbol.for("pi-theme:patched-user-message");
const PI_THEME = Symbol.for("@earendil-works/pi-coding-agent:theme");
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_CODE_RE = /\x1b\[([0-9;]*)m/g;
const OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const MAX = 90;
const PAD = "";
const TOOL_BG_KEYS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const clip = (value) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
};

const lastName = (name) => String(name || "").split(".").pop();
const stripAnsi = (line) => String(line).replace(ANSI_RE, "").replace(OSC_RE, "");
const trimLeft = (line) => line.replace(/^((?:\x1b\[[0-9;]*m)*)\s+/, "$1");
const rail = (theme = globalThis[PI_THEME]) => fg(theme, "dim", "┆");
function fg(theme, key, text) {
  try {
    return theme?.fg?.(key, text) ?? text;
  } catch {
    return text;
  }
}

function safePatch(patch) {
  try {
    patch();
  } catch {
    // pi-theme should never block Pi startup if upstream internals change.
  }
}

function fit(line, width) {
  const clipped = truncateToWidth(line, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function fallbackRender(render, component, width) {
  try {
    return render.call(component, width);
  } catch {
    return [];
  }
}

function stripBgAnsi(text) {
  return String(text).replace(ANSI_CODE_RE, (_match, codeText) => {
    const codes = codeText ? codeText.split(";").map(Number) : [0];
    const kept = [];
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107)) continue;
      if (code === 48) {
        i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
        continue;
      }
      kept.push(code);
    }
    return kept.length ? `\x1b[${kept.join(";")}m` : "";
  });
}

function summarize(name, args = {}) {
  switch (lastName(name)) {
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
  if (args.qa) return args.qa.attached ? "qa attached" : clip(`qa ${args.qa.url || ""}`);
  if (args.electron) return clip(`electron ${args.electron.action || ""} ${args.electron.appName || args.electron.bundleId || args.electron.appPath || ""}`);
  if (args.sourceLookup) return clip(`source ${args.sourceLookup.componentName || args.sourceLookup.selector || "lookup"}`);
  if (args.networkSourceLookup) return clip(`network ${args.networkSourceLookup.url || args.networkSourceLookup.filter || "lookup"}`);
  return "";
}

function summarizeParallel({ tool_uses: uses } = {}) {
  return Array.isArray(uses) ? clip(`${uses.length} tools: ${uses.map((use) => use.recipient_name || use.name || "tool").join(", ")}`) : "";
}

function clearToolBackground(theme) {
  for (const target of [theme, globalThis[PI_THEME]].filter(Boolean)) {
    for (const key of TOOL_BG_KEYS) {
      if (target.bgColors instanceof Map) target.bgColors.set(key, "\x1b[49m");
      else target.bgColors && (target.bgColors[key] = "\x1b[49m");
    }
  }
}

function toolLine(theme, name, value, context) {
  clearToolBackground(theme);
  const status = context?.isError ? "error" : context?.isPartial === false ? "success" : "running";
  const color = status === "error" ? "error" : status === "running" ? "warning" : "success";
  const icon = status === "error" ? "✗" : status === "running" ? "›" : "✓";
  const tool = status === "error" ? fg(theme, "error", name) : fg(theme, "dim", name);
  return new Text(`${rail(theme)} ${fg(theme, color, icon)} ${tool}${value ? ` ${fg(theme, "dim", value)}` : ""}`, 0, 0);
}

function trimBlank(lines) {
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && !stripAnsi(lines[start]).trim()) start++;
  while (end >= start && !stripAnsi(lines[end]).trim()) end--;
  return lines.slice(start, end + 1);
}

function hasAnsiCode(line, code) {
  for (const match of line.matchAll(ANSI_CODE_RE)) {
    if (match[1].split(";").map(Number).includes(code)) return true;
  }
  return false;
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

function padThinkingLine(line) {
  const cleaned = stripBgAnsi(trimLeft(line));
  return isThinkingLine(cleaned) ? `${PAD}${rail()} ${cleaned}` : line;
}

function cleanAssistantLine(line) {
  const leading = stripAnsi(line).match(/^\s*/)?.[0].length ?? 0;
  return padThinkingLine(leading <= 3 ? trimLeft(line) : line);
}

function assistantBubble(lines, width) {
  return [
    framedTop("pi", width, { labelColor: "customMessageText", borderColor: "borderMuted" }),
    ...lines.map((line) => framedLine(line, width, "customMessageText", "borderMuted")),
    framedBottom(width, "borderMuted"),
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
    try {
      return Boolean(this?.toolName) || originalHasRendererDefinition?.call(this);
    } catch {
      return false;
    }
  };

  proto.getCallRenderer = function getCallRenderer() {
    return (args, theme, context) => {
      try {
        return toolLine(theme, this.toolName, summarize(this.toolName, args), context);
      } catch {
        return new Text(String(this.toolName || "tool"), 0, 0);
      }
    };
  };

  proto.getResultRenderer = () => () => new Text("", 0, 0);

  if (typeof originalRender === "function") {
    proto.render = function renderCompactTool(width) {
      try {
        const innerWidth = Math.max(1, width - PAD.length);
        return trimBlank(originalRender.call(this, innerWidth))
          .map((line) => PAD + truncateToWidth(trimLeft(line), innerWidth, ""));
      } catch {
        return fallbackRender(originalRender, this, width);
      }
    };
  }

  proto[TOOL_PATCHED] = true;
}

function hasThinkingContent(component) {
  return component?.lastMessage?.content?.some((item) => item?.type === "thinking" && item?.thinking?.trim());
}

function patchAssistant() {
  const proto = AssistantMessageComponent?.prototype;
  if (!proto || proto[ASSISTANT_PATCHED]) return;

  const originalRender = proto.render;
  if (typeof originalRender !== "function") return;

  proto.render = function renderAssistantBubble(width) {
    try {
      const bubbleWidth = Math.max(1, width - 2);
      const renderWidth = hasThinkingContent(this) ? Math.max(1, bubbleWidth - PAD.length) : bubbleWidth;
      const rendered = originalRender.call(this, renderWidth);

      if (this.hasToolCalls) {
        return rendered.map((line) => truncateToWidth(padThinkingLine(line), width, ""));
      }

      const lines = trimBlank(rendered)
        .filter((line) => !stripAnsi(line).trim().startsWith("```"))
        .map(cleanAssistantLine)
        .map((line) => truncateToWidth(line, bubbleWidth, ""));

      if (!lines.length) return lines;
      const [thinkingLines, responseLines] = splitLeadingThinking(lines);
      return responseLines.length ? [...thinkingLines, "", ...assistantBubble(responseLines, width)] : thinkingLines;
    } catch {
      return fallbackRender(originalRender, this, width);
    }
  };

  proto[ASSISTANT_PATCHED] = true;
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
  for (const entry of session.sessionManager?.getEntries?.() ?? []) {
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
  const percent = session.getContextUsage?.()?.percent;
  const known = percent !== null && percent !== undefined;
  const safePercent = known ? Math.max(0, Math.min(100, percent)) : 0;
  const used = Math.round(safePercent / 10);
  const color = percent > 90 ? "error" : percent > 70 ? "warning" : "success";
  const bar = `${fg(theme, color, "─".repeat(used))}${fg(theme, "dim", "─".repeat(10 - used))}`;
  return `ctx ${bar} ${known ? `${percent.toFixed(0)}%` : "?%"}`;
}

function modelLabel({ state }) {
  const model = state.model?.id || "no-model";
  return state.model?.reasoning && state.thinkingLevel && state.thinkingLevel !== "off" ? `${model} • ${state.thinkingLevel}` : model;
}

function footerStatsLine(session, width) {
  const left = [usageStats(session), contextBar(session)].filter(Boolean).join(" ");
  const right = modelLabel(session);
  const room = width - visibleWidth(left) - visibleWidth(right);
  const line = room >= 2 ? left + " ".repeat(room) + right : truncateToWidth(`${left} ${right}`, width, "");
  return fg(globalThis[PI_THEME], "dim", line);
}

function subtleFooterStatus(line, width) {
  const text = stripAnsi(line)
    .replace(/[●○]/g, "•")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return fg(globalThis[PI_THEME], "dim", truncateToWidth(text, width, ""));
}

function patchRtkStatus() {
  const proto = InteractiveMode?.prototype;
  if (!proto || proto[STATUS_PATCHED] || typeof proto.showStatus !== "function") return;

  const originalShowStatus = proto.showStatus;

  proto.showStatus = function showPaddedRtkStatus(message) {
    originalShowStatus.call(this, message);
    try {
      if (!this.lastStatusText) return;
      const isRtk = String(message).startsWith("RTK rewrite:");
      this.lastStatusText.paddingX = isRtk ? PAD.length : 1;
      if (isRtk) this.lastStatusText.setText?.(`${rail()} ${fg(globalThis[PI_THEME], "dim", stripAnsi(message))}`);
      this.lastStatusText.invalidate?.();
    } catch {
      // Ignore styling failures; the status already rendered.
    }
  };

  proto[STATUS_PATCHED] = true;
}

function framedTop(label, width, { align = "left", labelColor = "accent", borderColor = "borderMuted" } = {}) {
  const theme = globalThis[PI_THEME];
  const border = (text) => fg(theme, borderColor, text);
  const title = fg(theme, labelColor, ` ${label} `);
  const fill = border("─".repeat(Math.max(0, width - visibleWidth(` ${label} `) - 3)));
  return align === "right"
    ? `${border("╭")}${fill}${title}${border("─╮")}`
    : `${border("╭─")}${title}${fill}${border("╮")}`;
}

function framedBottom(width, borderColor = "borderMuted") {
  return fg(globalThis[PI_THEME], borderColor, `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function framedLine(line, width, color = "", borderColor = "borderMuted") {
  const theme = globalThis[PI_THEME];
  const left = fg(theme, borderColor, "│ ");
  const right = fg(theme, borderColor, " │");
  const text = color ? fg(theme, color, line) : line;
  return left + fit(text, Math.max(0, width - 4)) + right;
}

function inputTop(width) {
  return framedTop("prompt", width, { labelColor: "muted", borderColor: "borderMuted" });
}

function inputBottom(width) {
  return framedBottom(width, "borderMuted");
}

function inputLine(line, width) {
  return framedLine(line, width, "", "borderMuted");
}

function isEditorRule(line) {
  return stripAnsi(line).trim().startsWith("─");
}

function patchInput() {
  const proto = CustomEditor?.prototype;
  if (!proto || proto[INPUT_PATCHED] || typeof proto.render !== "function") return;

  const originalRender = proto.render;
  proto.render = function renderPrettyInput(width) {
    try {
      if (width < 8) return fallbackRender(originalRender, this, width);
      const lines = originalRender.call(this, Math.max(1, width - 2));
      let bottom = -1;
      for (let i = lines.length - 1; i > 0; i--) {
        if (isEditorRule(lines[i])) {
          bottom = i;
          break;
        }
      }
      if (bottom < 1 || !isEditorRule(lines[0])) return fallbackRender(originalRender, this, width);
      return lines.map((line, index) => {
        if (index === 0) return inputTop(width);
        if (index === bottom) return inputBottom(width);
        return inputLine(line, width);
      });
    } catch {
      return fallbackRender(originalRender, this, width);
    }
  };

  proto[INPUT_PATCHED] = true;
}

function userLines(text, width) {
  const contentWidth = Math.max(1, width - 4);
  const lines = String(text ?? "")
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(line || " ", contentWidth));
  return [
    OSC133_ZONE_START + framedTop("you", width, { align: "right", labelColor: "userMessageText", borderColor: "border" }),
    ...(lines.length ? lines : [""]).map((line) => framedLine(line, width, "userMessageText", "border")),
    OSC133_ZONE_END + OSC133_ZONE_FINAL + framedBottom(width, "border"),
  ];
}

function patchUserMessages() {
  const proto = UserMessageComponent?.prototype;
  if (!proto || proto[USER_PATCHED] || typeof proto.render !== "function") return;

  const originalRender = proto.render;
  proto.render = function renderPrettyUserMessage(width) {
    try {
      if (width < 8 || typeof this.text !== "string") return fallbackRender(originalRender, this, width);
      return userLines(this.text, width);
    } catch {
      return fallbackRender(originalRender, this, width);
    }
  };

  proto[USER_PATCHED] = true;
}

function patchFooter() {
  const proto = FooterComponent?.prototype;
  if (!proto || proto[FOOTER_PATCHED]) return;

  const originalRender = proto.render;
  if (typeof originalRender !== "function") return;

  proto.render = function renderPiThemeFooter(width) {
    const lines = fallbackRender(originalRender, this, width);
    try {
      if (lines.length > 1) lines[1] = truncateToWidth(footerStatsLine(this.session, width), width, "");
      for (let i = 2; i < lines.length; i++) lines[i] = subtleFooterStatus(lines[i], width);
    } catch {
      return lines;
    }
    return lines;
  };

  proto[FOOTER_PATCHED] = true;
}

export default function piTheme() {
  [patchTools, patchAssistant, patchInput, patchUserMessages, patchRtkStatus, patchFooter].forEach(safePatch);
}
