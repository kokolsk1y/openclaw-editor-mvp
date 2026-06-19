// editor-agent — эталонная реализация (MVP).
// Пайплайн: /article <тема> → поиск (Tavily) → статья со ссылками (OpenRouter) →
// черновик с inline-кнопками [Опубликовать]/[Отклонить] → /revise доработка →
// публикация в канал ТОЛЬКО после нажатия "Опубликовать".
//
// Нативно (OpenClaw): кнопки (presentation), LLM (api.runtime.llm.complete), поиск (webSearch).
// Публикация в канal — прямым вызовом Telegram API токеном бота (TELEGRAM_BOT_TOKEN).

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const NS = "editor";
const drafts = new Map(); // senderId -> { topic, sources, article }

function buttons() {
  return {
    blocks: [
      {
        type: "buttons",
        buttons: [
          { label: "✅ Опубликовать", value: `${NS}:publish`, style: "primary" },
          { label: "✋ Отклонить", value: `${NS}:reject`, style: "danger" },
        ],
      },
    ],
  };
}

export default definePluginEntry({
  id: "agentstub",
  name: "OpenClaw Editor Agent (MVP)",
  description: "Полный пайплайн: поиск → статья со ссылками → согласование кнопками → публикация",
  register(api) {
    // ── поиск источников: нативный webSearch (провайдер tavily из config), с фолбэком на raw Tavily ──
    async function searchSources(query) {
      let items = [];
      try {
        const r = await api.runtime.webSearch.search({ args: { query } });
        const res = r?.result ?? r ?? {};
        items = res.results ?? res.result?.results ?? res.data ?? [];
      } catch (e) {
        api.logger?.warn?.("[editor] webSearch failed: " + (e?.message ?? e));
      }
      if (!items.length) {
        try {
          const resp = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.SEARCH_API_KEY}`,
            },
            body: JSON.stringify({ query, max_results: 5 }),
          });
          const data = await resp.json();
          items = data?.results ?? [];
        } catch (e) {
          api.logger?.warn?.("[editor] tavily fallback failed: " + (e?.message ?? e));
        }
      }
      return (items || []).slice(0, 5).map((x) => ({
        title: x.title ?? "",
        url: x.url ?? "",
        content: x.content ?? "",
      }));
    }

    // ── генерация статьи: нативный llm.complete (ответ в .text) ──
    async function writeArticle(topic, sources, feedback) {
      const src = sources
        .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${(s.content || "").slice(0, 500)}`)
        .join("\n\n");
      const prompt =
        `Напиши краткую структурированную статью на русском по теме «${topic}» ` +
        `СТРОГО на основе источников ниже. Не выдумывай факты и URL. 3–5 абзацев, заголовок, ` +
        `в конце раздел «Источники» со списком ссылок из источников.` +
        (feedback ? `\n\nУчти замечание редактора: ${feedback}` : "") +
        `\n\nИСТОЧНИКИ:\n${src}`;
      const out = await api.runtime.llm.complete({ messages: [{ role: "user", content: prompt }] });
      return (out?.text ?? "(пустой ответ модели)").slice(0, 3500);
    }

    // ── публикация в канал: прямой Telegram API токеном бота ──
    async function publishToChannel(text) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHANNEL_ID;
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      return resp.ok;
    }

    // ── /start ──
    api.registerCommand({
      name: "start",
      description: "Запустить бота",
      acceptsArgs: false,
      requireAuth: false,
      handler: () => ({
        text:
          "Editor-бот. Команды:\n" +
          "• /article <тема> — собрать черновик статьи со ссылками\n" +
          "• /revise <замечание> — доработать текущий черновик\n" +
          "Публикация в канал — только после нажатия «Опубликовать».",
        continueAgent: false,
      }),
    });

    // ── /article <тема>: поиск → статья → черновик с кнопками ──
    api.registerCommand({
      name: "article",
      description: "Сгенерировать черновик статьи по теме",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const topic = String(ctx.args ?? "").trim();
        if (!topic) return { text: "Укажи тему: /article <тема>", continueAgent: false };
        const sources = await searchSources(topic);
        if (!sources.length)
          return { text: "Не нашёл источников по теме. Попробуй другую формулировку.", continueAgent: false };
        const article = await writeArticle(topic, sources);
        drafts.set(ctx.senderId, { topic, sources, article });
        return {
          text: `📝 Черновик по теме «${topic}»:\n\n${article}`,
          presentation: buttons(),
          continueAgent: false,
        };
      },
    });

    // ── /revise <замечание>: доработка текущего черновика ──
    api.registerCommand({
      name: "revise",
      description: "Доработать черновик по замечанию",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const feedback = String(ctx.args ?? "").trim();
        const d = drafts.get(ctx.senderId);
        if (!d) return { text: "Нет активного черновика. Начни с /article <тема>", continueAgent: false };
        if (!feedback) return { text: "Укажи замечание: /revise <что улучшить>", continueAgent: false };
        const article = await writeArticle(d.topic, d.sources, feedback);
        drafts.set(ctx.senderId, { ...d, article });
        return {
          text: `📝 Доработанный черновик «${d.topic}»:\n\n${article}`,
          presentation: buttons(),
          continueAgent: false,
        };
      },
    });

    // ── клик по кнопке: namespace "editor" → ctx.callback.payload = publish|reject ──
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: NS,
      handler: async (ctx) => {
        const action = ctx?.callback?.payload;
        const d = drafts.get(ctx.senderId);
        if (action === "publish") {
          if (!d) {
            await ctx.respond.editMessage({ text: "Черновик не найден — начни заново: /article <тема>" });
            return { handled: true };
          }
          const ok = await publishToChannel(d.article);
          await ctx.respond.editMessage({
            text: ok
              ? "✅ Опубликовано в канал."
              : "❌ Не удалось опубликовать (проверь, что бот — админ канала).",
          });
          if (ok) drafts.delete(ctx.senderId);
          return { handled: true };
        }
        if (action === "reject") {
          await ctx.respond.editMessage({
            text: "✋ Отклонено. Что улучшить? Отправь: /revise твоё замечание",
          });
          return { handled: true };
        }
        return { handled: true };
      },
    });
  },
});
