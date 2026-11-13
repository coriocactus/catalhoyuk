# pi-catalhoyuk

Seven local extensions for the Pi terminal coding agent. They change how Pi's transcript is drawn and paged, and let an agent hand work to other Pi processes.

## Language

### Transcript

**Transcript**:
The conversation as Pi draws it in the terminal: a column of rows, oldest first.
_Avoid_: chat, document, history

**Entry**:
One saved step of a Pi session, such as a message, a tool result, or a compaction.
_Avoid_: record, item

**Row**:
One unit of the transcript that Pi adds, redraws, and removes as a whole: a message, a group of calls, a comrade.
_Avoid_: card, component, line

**Line**:
One terminal line of a row, as drawn at the current width.
_Avoid_: row, rendered row

**Continuation line**:
A line that carries on the text of the line above it after a wrap.
_Avoid_: wrapped row, continuation row

**Marker**:
An invisible mark in a line that says where the line's content starts, or how it continues the line above.

**Header**:
The first line of a row: its status, what it is, and a caret when it can expand.

**Expanded**, **collapsed**:
Whether a row shows its detail or only its header.
_Avoid_: open, closed, opened, at rest

### Calls

**Call**:
One use of a tool by an agent: its arguments and, once it ends, its result.
_Avoid_: tool row, row

**Group**:
Consecutive calls with nothing visible between them, drawn as one row.
_Avoid_: run, tool run, batch

**Leader**:
The first call of a group. Its row draws the whole group.

**Boundary**:
Whatever ends a group: visible text or thinking, a user message, a call the extensions do not draw, a failed turn.
_Avoid_: fence, separator

**Summary**:
The header of a group of several calls, which counts them by kind.

**Script**:
A call whose code makes calls of its own.

**Nested call**:
A call made by a script rather than by the agent directly.
_Avoid_: inner call, sub-call, nested row

**In progress**:
Said of a call that has not ended, whether its arguments still stream or it is running.
_Avoid_: live, pending

**Live**:
Seen while it happened in this Pi process, so its output is known.
_Avoid_: running, current

**Saved**:
Rebuilt from the session after a reload or resume, with only what Pi kept.
_Avoid_: archived, restored

### History

**History**:
The entries older than the first one drawn, on the same branch.
_Avoid_: archive, backlog

**Page**:
A set of history entries loaded and drawn together when the transcript is scrolled to its top.
_Avoid_: batch, chunk

**Anchor**:
The line at the top of the viewport, which stays in place while a page is added above it.

### Adapters

**Native**:
As Pi draws or behaves without these extensions.
_Avoid_: built-in, original, stock

**Adapter**:
A part of an extension that changes native behaviour where Pi offers no extension point, by replacing methods of Pi's classes while Pi runs.
_Avoid_: hook, monkeypatch, wrapper, shim

**Patch**:
The methods one adapter has replaced, together with what they replaced.
_Avoid_: override, hook

**Owner**:
A loaded extension that holds a share in a patch. A patch is undone when its last owner lets go.
_Avoid_: user, holder

**Probe**:
A check an adapter makes of native behaviour before it patches, and of its patch afterwards.

**Fallback**:
Native behaviour left in place, with one warning, because a probe failed.

### Comrades

**Comrade**:
A separate Pi process given one self-contained task. It has a number, `#N`, and keeps its own conversation.
_Avoid_: subagent, sub-agent, child, worker

**Caller**:
The agent that started a comrade and reads its answer.
_Avoid_: parent, owner, main agent

**Host**:
The Pi process that runs a comrade's run and delivers its answer.
_Avoid_: owner, parent

**Task**:
The instructions a caller gives a comrade for one run.
_Avoid_: prompt, brief

**Conversation**:
Everything a comrade has been told, done, and said, across all its runs.
_Avoid_: session, transcript, history

**Run**:
One stretch of a comrade's work, from a task to an ending.
_Avoid_: turn, tool run

**Foreground run**:
A run the caller waits for. Its answer is the result of the call that started it.

**Background run**:
A run the caller does not wait for. Its answer is delivered later.
_Avoid_: detached run

**Job**:
A background run in progress in its host: what the host holds to follow it, steer it, and stop it.
_Avoid_: task, worker

**Follow-up**:
A run that continues a comrade's conversation with a new task.
_Avoid_: continuation, follow-up message

**Steer**:
A message sent to a comrade during a run, which joins that run.
_Avoid_: tell, nudge, message while it runs

**Answer**:
The last text a comrade wrote in a run.
_Avoid_: result, output, reply

**Delivery**:
The message that brings a background run's answer into the caller's session.
_Avoid_: notification, follow-up message

**Ending**:
How a run ended: finished, failed, stopped, or lost.
_Avoid_: outcome, status, phase

**Interrupted**:
Said of a run that ended without an answer: stopped, timed out, or its host exited.
_Avoid_: cut off

**Partial**:
Said of an answer whose last turn ended early, usually at the model's output limit.
_Avoid_: cut off, truncated

**Truncated**:
Said of an answer shortened for the caller because of its length, with the whole text kept in a file.
_Avoid_: cut off, clipped

**Resume**:
To start a run that carries an interrupted background run through to its answer.
_Avoid_: carry on, recover, continue

**Lost**:
Said of a background run whose answer can no longer arrive.

**Reconcile**:
To decide, when a session starts, what becomes of each background run that never answered.
_Avoid_: recover, settle

**Run record**:
What a host notes about a run beside the conversation, so that another Pi can tell who runs it and its answer survives an exit.
_Avoid_: record

**Run details**:
The facts about a run that its row shows and the session keeps: model, turns, calls, cost, duration, ending.
_Avoid_: card, summary, stats

**Run line**:
The one-line account of a run that ends what the caller reads.

**Start row**:
The row of the call that started a background run, as distinct from the row of its delivery.

**Title**:
The few words by which a caller names a comrade's row.

### Editor

**Snippet**:
A Markdown file whose text is inserted at the cursor in place of its name.
_Avoid_: template, macro

**Arm**:
To take a first `Esc` as a warning, so that only a second one soon after interrupts.
_Avoid_: confirm, guard
