import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";

/**
 * Pre-configured Marked instance with syntax highlighting via highlight.js.
 * Exported as a singleton — all callers share the same renderer config.
 */
const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Render a markdown string to HTML.
 * Safe for incremental (streaming) use — caller replaces innerHTML each time.
 */
export function renderMarkdown(source: string): string {
  const result = marked.parse(source);
  // marked.parse can return string or Promise<string> depending on config.
  // With our synchronous highlight config it always returns string.
  return result as string;
}
