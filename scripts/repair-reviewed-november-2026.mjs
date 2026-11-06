import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This is a one-incident operator, not an ingestion or automatic-merge path.
// Preview one exact live step; apply it once with that preview's digest and a
// new private receipt. Re-preview after every step or uncertain response.
export const REVIEWED_NOVEMBER_ORIGIN = "https://convex-events.ineedtofeedmyrabbit.com";
export const REVIEWED_NOVEMBER_GROUPS = Object.freeze([
  { key: "dksg-nov6", label: "DKSG Dete noci, 6 November", primaryId: "j57bjfm2che5etgz0ew3qcj5m58hfvnp" },
  { key: "bitef-nov6", label: "Bitef Necista krv, 6 November", primaryId: "j5711fams3rvneezkv35srzqvn8hkv5d" },
  { key: "ladidadi-nov6", label: "LadiDadi winter edition, 6 November", primaryId: "j576n6c3n6wghjamyckxxew5q18h8gfy" },
  { key: "tranzit-nov6", label: "Tranzit Kuca Dobrog Ritma, 6 November", primaryId: "j57bx8xrb42hnvgeqfmx00mafd8hekzs" },
  { key: "bife-nov7", label: "Bife Pad Kra Pao with Aux of Pain, 7 November", primaryId: "j577tr534ay5fdhm9vghza8qt58hnj0t" },
  { key: "vrtoglavica-nov6", label: "Vrtoglavica Friday room programs, 6 November", primaryId: "j57emjde9hz7yn8a8875hha5sd8h4j1m" },
  { key: "kuko-nov7", label: "KUKO All Night Long, 7 November", primaryId: "j578jtqtf9p1ckhrzp4eec4w198dfdr9" },
]);

const PROTECTED = Object.freeze([
  { id: "j57bcps5x8s9zs8ma39qbwwdr98he2y5", date: "2026-11-06", title: "STABLO MASLINE", time: "18:30", venueId: "k172xcmnd3qw4jqgcswwwrykw5896new" },
  { id: "j576qhgday1np01bdr8rffg5an8he0ze", date: "2026-11-06", title: "PUKOTINA U LEDU", time: "20:30", venueId: "k172xcmnd3qw4jqgcswwwrykw5896new" },
  { id: "j571yaaxec9prd561m0mxdgs4h8h40jz", date: "2026-11-07", title: "\u0110uskali\u0161te", time: "22:00", venueId: "k174najg8yc8jksdmrsps5znr58970vq" },
]);
const API = Object.freeze({ context: "reviewedNovember2026Repairs:getContext", consolidate: "reviewedNovember2026Repairs:consolidate" });
const NOTE = "User-reviewed November 2026 correction: consolidate only the pinned duplicate performance announcements, preserving source provenance, saved events and independent sessions.";
const RECEIPT_SCHEMA = "eventzeka-reviewed-november-2026-receipt-v1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function stableReviewedJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}

function sha256(value) {
  return createHash("sha256").update(stableReviewedJson(value)).digest("hex");
}

function protectedProjection(rows) {
  assert(Array.isArray(rows), "Protected event read did not return an array.");
  return PROTECTED.map((expected) => {
    const matches = rows.filter((row) => row?._id === expected.id);
    assert(matches.length === 1, `Protected event is missing or ambiguous: ${expected.id}.`);
    const event = matches[0];
    assert(event.status === "approved" && Object.entries(expected).every(([key, value]) => key === "id" || event[key] === value),
      `Protected independent event changed: ${expected.id}.`);
    // Derived publication evaluation timestamps can change without changing a
    // performance. Preserve every factual and source-evidence field exactly.
    return Object.fromEntries(Object.entries(event).filter(([key]) => ![
      "publicationEvaluatedAt", "publicationPolicyVersion", "publicationReason", "publicationState",
    ].includes(key)));
  });
}

export async function loadReviewedNovemberSnapshot(adapter, groupKey) {
  assert(groupKey === undefined || REVIEWED_NOVEMBER_GROUPS.some((group) => group.key === groupKey), "Unknown reviewed November group.");
  const groups = groupKey ? REVIEWED_NOVEMBER_GROUPS.filter((group) => group.key === groupKey) : REVIEWED_NOVEMBER_GROUPS;
  const [protectedEvents, ...contexts] = await Promise.all([
    adapter.query("events:getManyByIds", { ids: PROTECTED.map((event) => event.id) }),
    ...groups.map((group) => adapter.query(API.context, { groupKey: group.key })),
  ]);
  const protectedRows = protectedProjection(protectedEvents);
  const reviewedGroups = groups.map((group, index) => {
    const context = contexts[index];
    assert(context && typeof context === "object" && !Array.isArray(context) && typeof context.complete === "boolean",
      `Reviewed backend returned an invalid context: ${group.key}.`);
    assert(context.groupKey === group.key && context.primaryId === group.primaryId,
      "Reviewed backend returned the wrong pinned group or primary event.");
    return { ...group, context };
  });
  return { groups: reviewedGroups, protectedEvents: protectedRows };
}

export function buildReviewedNovemberPlan(snapshot) {
  const pending = snapshot.groups.find((group) => !group.context.complete);
  const next = pending ? {
    groupKey: pending.key,
    functionName: API.consolidate,
    args: {
      groupKey: pending.key,
      // Preserve the server's deterministic serialization for its atomic fence.
      expectedContextJson: JSON.stringify(pending.context),
      moderationNote: NOTE,
    },
  } : null;
  const planSha256 = next ? sha256({ schema: RECEIPT_SCHEMA, origin: REVIEWED_NOVEMBER_ORIGIN, next, protectedEvents: snapshot.protectedEvents }) : null;
  return {
    next,
    planSha256,
    steps: snapshot.groups.map((group) => ({ groupKey: group.key, label: group.label, primaryId: group.primaryId, complete: group.context.complete })),
  };
}

export async function runReviewedNovemberRepair(adapter, options = {}) {
  const before = await loadReviewedNovemberSnapshot(adapter, options.groupKey);
  const plan = buildReviewedNovemberPlan(before);
  const receipt = {
    schema: RECEIPT_SCHEMA, origin: REVIEWED_NOVEMBER_ORIGIN,
    mode: options.apply ? "apply-one-step" : "preview", status: "preview",
    observedAt: adapter.now(), planSha256: plan.planSha256,
    groupKey: plan.next?.groupKey ?? null, before,
  };
  if (!options.apply) {
    await adapter.saveReceipt?.(receipt);
    return { mode: "preview", nextStep: plan.next?.groupKey ?? null, planSha256: plan.planSha256, steps: plan.steps };
  }
  assert(plan.next && /^[a-f0-9]{64}$/u.test(options.expectedHash ?? "") && plan.planSha256 === options.expectedHash,
    "The exact live repair plan changed after preview, or all selected steps are complete.");
  assert(typeof adapter.saveReceipt === "function", "Apply requires a private before/after receipt.");
  await adapter.saveReceipt(receipt);
  try {
    const fresh = await loadReviewedNovemberSnapshot(adapter, options.groupKey);
    assert(buildReviewedNovemberPlan(fresh).planSha256 === plan.planSha256,
      "The source, event, saved references or protected sessions changed before apply.");
    receipt.status = "applying";
    await adapter.saveReceipt(receipt);
    // Never retry a mutation after a transport error: it may have committed.
    receipt.result = await adapter.mutation(plan.next.functionName, plan.next.args);
    const after = await loadReviewedNovemberSnapshot(adapter, options.groupKey);
    receipt.after = after;
    assert(after.groups.find((group) => group.key === plan.next.groupKey)?.context.complete === true,
      "Mutation returned without the exact reviewed group becoming complete; re-preview before any retry.");
    assert(stableReviewedJson(before.protectedEvents) === stableReviewedJson(after.protectedEvents),
      "A protected independent performance changed during repair.");
    receipt.status = "applied";
    receipt.completedAt = adapter.now();
    await adapter.saveReceipt(receipt);
    const nextPlan = buildReviewedNovemberPlan(after);
    return { mode: "applied-one-step", appliedStep: plan.next.groupKey, nextStep: nextPlan.next?.groupKey ?? null, steps: nextPlan.steps, result: receipt.result };
  } catch (error) {
    receipt.status = "failed-or-uncertain";
    receipt.failedAt = adapter.now();
    receipt.error = adapter.redactError ? adapter.redactError(error) : "Repair failed; inspect the private receipt and re-preview before retrying.";
    await adapter.saveReceipt(receipt);
    throw error;
  }
}

async function createPrivateReceiptWriter(receiptPath) {
  assert(path.isAbsolute(receiptPath), "Receipt path must be absolute and outside the source checkout.");
  const parent = await realpath(path.dirname(receiptPath));
  const parentStat = await lstat(parent);
  assert(parentStat.isDirectory() && (parentStat.mode & 0o077) === 0, "Receipt directory must be private (mode 0700).");
  const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  assert(parent !== root && !parent.startsWith(`${root}${path.sep}`), "Live repair receipts must stay outside the source checkout.");
  const filename = path.join(parent, path.basename(receiptPath));
  await writeFile(filename, "{}\n", { mode: 0o600, flag: "wx" });
  return async (receipt) => {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
  };
}

async function main(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (["--expect-plan-sha256", "--receipt", "--group"].includes(flag) && argv[index + 1]) options[flag.slice(2)] = argv[++index];
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  assert(!options.apply || (options.receipt && /^[a-f0-9]{64}$/u.test(options["expect-plan-sha256"] ?? "")),
    "Apply one previewed step with --apply --expect-plan-sha256 SHA256 --receipt NEW_PRIVATE_FILE.");
  assert(options.apply || !options["expect-plan-sha256"], "A plan digest is only accepted with --apply.");
  const serviceSecret = process.env.CRON_SECRET?.trim();
  const origin = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/+$/u, "");
  assert(serviceSecret && origin === REVIEWED_NOVEMBER_ORIGIN, "The private runtime must target the exact reviewed production Convex origin.");
  const { ConvexHttpClient } = await import("convex/browser");
  const client = new ConvexHttpClient(origin);
  const redactError = (error) => String(error instanceof Error ? error.message : error).replaceAll(serviceSecret, "[redacted]");
  const saveReceipt = options.receipt ? await createPrivateReceiptWriter(options.receipt) : undefined;
  const result = await runReviewedNovemberRepair({
    query: (name, args) => client.query(name, { ...args, serviceSecret }),
    mutation: (name, args) => client.mutation(name, { ...args, serviceSecret }),
    saveReceipt, redactError, now: () => new Date().toISOString(),
  }, { apply: options.apply, expectedHash: options["expect-plan-sha256"], groupKey: options.group });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    const secret = process.env.CRON_SECRET?.trim();
    const message = String(error instanceof Error ? error.message : error);
    console.error(`Reviewed November repair stopped: ${secret ? message.replaceAll(secret, "[redacted]") : message}`);
    process.exitCode = 1;
  });
}
