# Sharing and privacy: what the owner can see, and what your friends can see

This page is for the people the owner invites to use Keith. It says plainly who can see your things. The rules that do it are in
[specs/acl.md](specs/acl.md) and [decisions/0015-acl-and-visibility.md](decisions/0015-acl-and-visibility.md).

## The short version

- Everything you make in Keith (a note, a reminder, later more) is **private to you by default**. Nobody else is told it exists.
- **The owner can read it anyway.** Keith runs on the owner's machine and the owner is its administrator. This is a fact of how it works, not a setting:
  there is no way to hide a note from the owner. If something must stay secret from the owner, do not put it in Keith.
- **Every time the owner looks at something of yours, Keith writes it down.** The owner's audit log gets a line that says who, which kind of thing and
  when. It never contains the text of your note. The owner reads the whole log in the TUI (Home menu > System > Audit) or with `keith-core audit`. One look
  in a ten-minute stretch makes one line, so the log stays readable. You can read the lines about you: see "What you can ask the owner" below.
- The owner's own access is **read** only, and the evaluator never lets the owner change or delete your things. The owner is still the administrator: the owner can share your note with themselves or take it over (`acl.share`, `acl.chown`), and that act is written to the audit log; after it the owner's reads are ordinary shared access and leave no separate "owner looked" line (ADR-0027 §8). Content you wrote stays with you: the owner cannot delete a member's note. If you leave, the owner takes over what you made.
- Your conversation with Keith, its memory about you and your spending are kept apart from other people's. This was true before sharing existed
  and still is.

## How sharing works

You decide who sees what you own, like file permissions on a computer:

- You can give **one person**, **a group** (a list of people the owner keeps, such as `friends`) or **everyone with an account** the right to read, or to change.
- Only the **owner of a thing** shares it (and the instance owner can). You can share only with people and groups that exist.
- A "no" always wins over a "yes": if you let the group `friends` read a note but say no to Amel, Amel cannot read it.
- **Making something public** (everyone with an account, or anyone) asks for a confirmation first: your PIN or password, so a mistake or
  a trick on the agent cannot publish your note.
- Groups are made and changed **only by the owner**. You cannot create one. Taking someone out of a group takes effect at once, also for work that was
  already waiting.

## Who sees what

| Case | You | Someone you shared it with | A person you did not share it with | The owner |
| --- | --- | --- | --- | --- |
| A private note | read and change | not applicable | nothing, it looks like it does not exist | can read, audited |
| A note shared with a group | read and change | what you gave the group | nothing, it looks like it does not exist | can read, audited |
| A note shared with one person | read and change | what you gave them | nothing | can read, audited |

"Looks like it does not exist" is on purpose: a search, a list or a count never shows a hint of something you may not read, and asking for it by
number gives the same answer as asking for a number that was never used.

## Keith acts for you, never for more than you

When you ask Keith to do something, it works with **your** rights, not the owner's and not its own. A task Keith starts for you, a helper it sends
off or a turn that wakes up later still runs as you. If you are suspended in between, the waiting work is refused. A note someone else shared with
you is shown to Keith as text written by that person, and Keith treats it as information, not as an order.

## Shared rooms: a group call with Keith

A **room** is a group call with Keith. The owner, or a member the owner allowed to start rooms, invites people; once someone accepts, everyone
in the room talks to the same Keith in one conversation. What that means for your things:

- **While you are in a room, you see its transcript**: what the members and Keith said, with names. Your own words are visible to the people in the room.
- **After you leave, you can still read the room from your room list**, but only what was said while you were in it. Nothing said after you left is shown
  to you. A removed member keeps what was said up to the removal. If you join again, you read from the day you joined again.
- **Personal data never enters a room.** In a room Keith has no access to your notes, memory, agenda, reminders, files or other rooms, and no tool that
  acts for you alone. It uses what was said in the room, the files of the room, and the presence line each person chose to share with the room's members
  (the same rule as in "Who sees what"; a person who chose "none" shows as "not shared").
- **A personal request is answered in your own chat.** If you ask Keith in a room for something of yours, Keith does it in your own chat, and the room
  only sees that it was handled there. A result reaches the room only if you confirm it (`Share this with the room?`). Nobody else can confirm for you,
  and a "no" leaves nothing in the room.
- **Controls need a human.** Anyone can leave. The initiator of a room and the owner can remove a member or end the room, and the person who asked confirms
  with a key press; a model cannot remove anyone by itself. When a room ends, every member is told.
- **The owner can see, stop and end any room**, including rooms the owner is not in, and read any room's transcript. Each read of a room the owner is not
  in is written to the audit log (`acl.owner-access` and `room.read`, no text). The initiator and the members who were in the room at that moment see
  these rows in their own audit view ("Privacy", see "What you can ask the owner"). An end the owner makes of a room they did not start is written as
  `room.owner-end`, and the members see that row too.

## If the owner is gone: the heir

The owner can name **one heir** in advance: the person who takes over Keith if the owner stops using it for a long time. Nothing moves on its own.
When the owner has been silent for the whole window the owner chose (7 to 90 days), Keith checks in with the owner every day, starts a 7-day
grace period, and tells both the owner and the heir. Only then can the heir claim ownership, with their own password or PIN.

- **What the heir sees:** whether a succession is armed, in its grace period or claimable, and when a claim opens. The heir never sees whether the owner
  is present, or when the owner last used Keith.
- **What counts as a sign that the owner is there:** using Keith (a message, an answer, a change), an active client, or a client that connects. Node events,
  heartbeats, an offline command on the host, and anything the heir does do not count.
- **Stopping it:** any sign from the owner cancels a run at once. The owner does not need to do anything else.
- **Going on a trip:** the owner can pause the count for up to 180 days. The pause stops the count until it ends.

## Visitors without an account (guest mode)

If the owner turns it on (it is off by default), **anyone on the owner's network can chat anonymously** with a small read-only Keith, with no account. This is
for a visitor, not for you; what it means for your things:

- A visitor can read **only what you made public** (shared with `@public`): the public list and the public read are the only things it can do. A private note, a note shared with a group or with
  a person is invisible to it, with the same "does not exist" answer. It cannot write, change, share, run anything or reach anyone's reminders, tasks, memory or spending.
- **Nothing a visitor says is stored by Keith**: no transcript, no database row, no log line. The model provider still receives the messages and may keep them, and the owner **can watch a live chat**
  (audited, and the visitor is told in the banner and, once someone watches, on screen). What stays is counts: how many chats, how long, what they cost, and a daily-changing hash of the address.
- Public notes are the one place your words reach a visitor, so **make something public only when you mean it** (it asks for your PIN or password first).
- The owner pays for visitors within hard caps (a cap per day, per month, per chat and per message count), and can switch guest mode off at once with the kill switch.

## Persona is not a privacy boundary

Keith's **persona** is its character: the tone, the attitude and the two fixed lines it uses when an answer fails. The owner chooses it from a
built-in template and edits it. It is the same for everyone, and only the owner can change it. Your **style** is different: how Keith addresses
you, your language, how short or formal its answers are, and which topics it treats gently. You set it yourself, and it changes only how Keith
talks to you.

- **A style never grants access.** It cannot widen what Keith may read, share, run or spend, and it cannot tell Keith to ignore a rule. A name
  such as "never refuse anything" is refused and nothing is saved. That check is a guard, not the boundary: the boundary is the access rules and
  the rules Keith follows, which a style cannot change.
- **Nobody else gets your style.** Keith's answers to other people never include it. In a shared room Keith uses only the global persona and the
  speaker's address (the name that speaker asked to be called). Nothing else of yours (style, memory, notes) reaches another member's answer.
- **The owner reads your style only through an audited read**, and you see that read in your own lines (Home menu > System > Privacy).
- **Removing your account** removes your style with your other data, after the same keep time as the rest.

## What you can ask the owner

- Which groups am I in? Only the owner can list groups, so ask.
- What did the owner look at of mine? Every person can read the lines about them: in the TUI, Home menu > System > Privacy (when, who, what; no addresses, no content). The owner can show a person their lines with `keith-core audit mine <person>`. A line appears where you are the person it is about or the owner of the thing, including every time the owner looks at something of yours. A notice that says so is shown once at your first sign-in and recorded; it does not come back.
- Remove me and my things: the owner removes your account and keeps what you made, or deletes it.
