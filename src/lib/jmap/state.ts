import { currentSeq } from "./changes";
import { formatMailboxState, formatSeqState } from "./changes-utils";
import type { JmapContext } from "./types";
import { listAccessibleMailboxIdSet } from "./access";

/**
 * Opaque state strings, both read off the change log (migration 0033). The
 * Email state is the newest log sequence; Thread state shares it. Sequences
 * are global rather than per account: a client may see the state move and
 * fetch an empty change set, which is one indexed query, and in exchange the
 * log can be pruned from the front without per-account bookkeeping.
 */
export async function getEmailState(ctx: JmapContext): Promise<string> {
	return formatSeqState(await currentSeq(ctx));
}

/**
 * Mailbox counts live on Mailbox objects, so the mailbox state moves with the
 * email state; the digest of accessible mailbox ids catches mailboxes being
 * added, removed or shared, which the log does not record.
 */
export async function getMailboxState(ctx: JmapContext): Promise<string> {
	const [seq, ids] = await Promise.all([currentSeq(ctx), listAccessibleMailboxIdSet(ctx)]);
	return formatMailboxState(seq, ids);
}
