// Delivering background runs' answers into the caller's session, at least once. An answer is
// saved in its run's record before it is sent, and stays there until the session holds it: Pi
// keeps a message that arrives during a turn in memory until the turn ends, so one Pi exits
// with first, or that Esc clears, would otherwise be lost.
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { message } from "./answer.ts";
import { type Delivery, MESSAGE } from "./details.ts";
import { dropRuns, quietly, type RunRecord, readRuns } from "./runs.ts";
import type { Session } from "./session.ts";
import type { Running } from "./view.ts";

/** How long after the agent settles, idle, an answer it still does not hold is sent again. */
const RESEND_MS = 1000;

/** The messages that ended background runs, by run, on any branch. */
export function deliveries(
  entries: SessionEntry[],
): Map<string, SessionEntry & { type: "custom_message" }> {
  const runs = new Map<string, SessionEntry & { type: "custom_message" }>();
  for (const entry of entries) {
    if (entry.type !== "custom_message" || entry.customType !== MESSAGE) continue;
    const delivery = entry.details as Partial<Delivery> | undefined;
    if (delivery?.run && delivery.status !== "resumed") runs.set(delivery.run, entry);
  }
  return runs;
}

export interface OutboxHooks {
  /** Redraws comrade #id's background start rows, which say how its runs went. */
  redrawStartRows(id: number): void;
  refreshWidget(): void;
}

export type Outbox = ReturnType<typeof createOutbox>;

export function createOutbox(pi: ExtensionAPI, session: Session, hooks: OutboxHooks) {
  // Answers delivered to wake the agent, so a waiting turn knows one has arrived. Pi counts only
  // typed messages as pending, not an extension's queued follow-ups.
  let woken = 0;
  // Background answers saved and sent whose message the session may not hold yet:
  // run -> the comrade's conversation.
  const unconfirmed = new Map<string, string>();
  // When each was last sent, so one sent as the agent settled is not sent again at once.
  const sentAt = new Map<string, number>();
  /** Background runs that have ended, by run, until the session holds their answer. */
  const answered = new Map<string, Running>();

  const deliver = (delivery: Delivery, body: string, wake: boolean) => {
    if (wake) woken++;
    pi.sendMessage(
      {
        customType: MESSAGE,
        // Named by its title, as its row is; rows saved before titles, by the task's first line.
        content: message(delivery.id, delivery.status, delivery.title ?? delivery.task, body),
        display: true,
        details: delivery,
      },
      { deliverAs: "followUp", triggerTurn: wake },
    );
  };

  /** Drops the records of runs whose answer the session now holds. */
  const confirm = () => {
    if (!unconfirmed.size || !session.entries) return;
    const delivered = deliveries(session.entries());
    const done = new Map<string, Set<string>>();
    for (const [run, conversation] of unconfirmed) {
      if (!delivered.has(run)) continue;
      unconfirmed.delete(run);
      done.set(conversation, (done.get(conversation) ?? new Set<string>()).add(run));
    }
    for (const [conversation, runs] of done) quietly(() => dropRuns(conversation, runs));
    // Their lines in the widget go with them, and their start rows now say how they went.
    let changed = false;
    for (const runs of done.values())
      for (const run of runs) {
        changed = answered.delete(run) || changed;
        const id = (delivered.get(run)?.details as Partial<Delivery> | undefined)?.id;
        if (id !== undefined) hooks.redrawStartRows(id);
      }
    if (changed) hooks.refreshWidget();
  };

  /** Notes that a run's answer was sent now, to be confirmed once the session holds it. */
  const sent = (run: string, conversation: string) => {
    unconfirmed.set(run, conversation);
    sentAt.set(run, Date.now());
  };

  /** Sends a saved answer, which stays saved until the session holds it. */
  const resend = (conversation: string, answer: RunRecord<Delivery>, wake: boolean) => {
    if (!answer.answer) return;
    sent(answer.run, conversation);
    deliver(answer.answer.delivery, answer.answer.body, wake);
    confirm();
  };

  /** Sends the message another branch holds again, here, without starting a turn. */
  const redeliver = (entry: SessionEntry & { type: "custom_message" }) =>
    pi.sendMessage(
      {
        customType: MESSAGE,
        content: entry.content,
        display: entry.display,
        details: entry.details,
      },
      { deliverAs: "followUp", triggerTurn: false },
    );

  // Pi takes an answer queued behind a turn when the turn ends; in the terminal, Esc or the
  // dequeue key drops it instead. Once the agent has been idle a moment, so an answer sent as it
  // settled has been taken, any the session still does not hold is sent again, without starting
  // a turn. Only in the terminal, whose every abort clears the queue first: elsewhere an abort,
  // such as RPC's, leaves the answer queued for the next run, so sending it again would deliver
  // it twice. There, the saved record delivers an answer that never arrived at the next start.
  let settleCheck: ReturnType<typeof setTimeout> | undefined;
  const settled = (ctx: ExtensionContext) => {
    confirm();
    clearTimeout(settleCheck);
    settleCheck = setTimeout(() => {
      let idle = true;
      try {
        idle = ctx.isIdle?.() !== false;
      } catch {
        return;
      }
      if (!session.ui || !idle || !session.terminal) return;
      confirm();
      let gone = false;
      for (const [run, conversation] of unconfirmed) {
        if (Date.now() - (sentAt.get(run) ?? 0) < RESEND_MS) continue;
        const saved = readRuns<Delivery>(conversation).find((item) => item.run === run);
        if (saved?.answer) {
          sentAt.set(run, Date.now());
          deliver(saved.answer.delivery, saved.answer.body, false);
        } else {
          unconfirmed.delete(run);
          gone = answered.delete(run) || gone;
        }
      }
      confirm();
      if (gone) hooks.refreshWidget();
    }, RESEND_MS);
    settleCheck.unref();
  };

  /** Leaves the session. Answers still unconfirmed stay saved, and its next start delivers them. */
  const close = () => {
    confirm();
    unconfirmed.clear();
    sentAt.clear();
    answered.clear();
    clearTimeout(settleCheck);
  };

  return {
    deliver,
    confirm,
    sent,
    resend,
    redeliver,
    settled,
    close,
    answered,
    /** How many answers have been delivered to wake the agent. */
    woken: () => woken,
  };
}
