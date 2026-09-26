# Vision

## One sentence

**Keith is an assistant built like a human mind: one continuous awareness that can expand without limit.**

## "Like a human mind"

Today's AI agents are chat sessions. Each window is a fresh stranger with a transcript attached. Keith is built the other way around:

- **There is one of it.** When you talk to Keith, you talk to the same entity your partner talked to this morning. That entity knows it has been busy since then.
- **It has a foreground and a background.** It gives full attention to whoever is waiting for it. When nobody is, it works on tasks, reflects on what it learned, and checks whether something deserves your attention.
- **It keeps promises.** "I'll tell you when the report is ready" creates an obligation. Keith tracks it and speaks up on its own when the obligation is met.
- **It has relationships, not accounts.** Keith is formal with a guest, relaxed with the owner, and careful with what it tells whom. Each person sees a different face of the same mind. Context moves between people only when that is appropriate.
- **It talks the way people talk.** You can type, then speak, then type again, all in one conversation. It is still one conversation.

Iron Man's Jarvis is the reference. Jarvis holds one awareness while talking to Tony in the lab and Pepper on the phone. Each conversation stays its own, and it can bring context from one into the other when needed.

## "Expand without limit"

The mind lives in one core process. Everything else is an extension:

- **Surfaces (Nodes).** Terminal, browser, desktop app, phone, a speaker in the living room, a headless server whose filesystem Keith can reach. Each surface declares what it can do (text, audio, visuals, files) and Keith adapts to it.
- **Abilities (Plugins).** Tools, model providers, skills, agent roles, and client apps that need server-side code.
- **Places.** Nodes can run on many machines. The mind reaches out through them, and people reach in through them.

## The visual workspace

On a surface that can render visuals, Keith has a **workspace**: a set of windows it arranges itself. It can show today's news as a card, open a dashboard, embed a shared screen, or lay out several results side by side. All of it uses one consistent visual language. The workspace belongs to the mind, and the web client only draws it. See [`../architecture/workspace.md`](../architecture/workspace.md) (planned).

## What "done" feels like (north-star scenarios)

1. You ask for something that takes a while. Keith says it will get back to you, and you keep talking about something else. Keith interrupts politely when the work is done.
2. The next day, Keith remembers what you asked, what it found, and what you decided.
3. You start typing on your laptop, pick up your phone and speak. Keith answers out loud on the phone, and the laptop shows the same conversation as text.
4. Two people talk to Keith at the same time. Each gets their own conversation and tone. Neither learns the other's private details, and Keith knows it is busy with both.
5. You run Keith with only a terminal. Later you install the web plugin and get the visual workspace. Nothing about the mind changes.

## Non-goals

- Multi-tenant SaaS. Keith is personal and self-hosted: one household, one deployment.
- Federation between Keith instances.
- Being a general agent framework. Keith is a product with an opinionated shape. Its plugin API serves that shape.
