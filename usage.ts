import type {
  AssistantMessage,
  Message,
  Model,
  OpencodeClient,
  Provider,
  Session,
} from "@opencode-ai/sdk/v2";

export type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  cost: number;
};

export type DescendantData = {
  sessions: ReadonlyArray<Session>;
  turns: number;
};

export type CostMode = "reported" | "estimated" | "mixed";

type CostMessage = Pick<
  AssistantMessage,
  "providerID" | "modelID" | "tokens"
> & { cost?: number };

export const EMPTY: TokenTotals = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  cost: 0,
};

export const EMPTY_DESCENDANTS: DescendantData = { sessions: [], turns: 0 };
const FETCH_CONCURRENCY = 4;

function hasPrice(model: Model): boolean {
  const cost = model.cost;
  return (
    cost.input > 0 ||
    cost.output > 0 ||
    cost.cache.read > 0 ||
    cost.cache.write > 0 ||
    Boolean(cost.tiers?.some((tier) =>
      tier.input > 0 ||
      tier.output > 0 ||
      tier.cache.read > 0 ||
      tier.cache.write > 0
    )) ||
    Boolean(
      cost.experimentalOver200K &&
      (cost.experimentalOver200K.input > 0 ||
        cost.experimentalOver200K.output > 0 ||
        cost.experimentalOver200K.cache.read > 0 ||
        cost.experimentalOver200K.cache.write > 0),
    )
  );
}

function normalizedModelID(id: string): string {
  return (id.split("/").pop() || id).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pricingFor(
  providers: ReadonlyArray<Provider>,
  providerID: string,
  modelID: string,
): Model | undefined {
  const provider = providers.find((entry) => entry.id === providerID);
  const exact = provider?.models[modelID] ??
    Object.values(provider?.models ?? {}).find((model) => model.id === modelID);
  if (exact && hasPrice(exact)) return exact;

  const normalized = normalizedModelID(modelID);
  return providers
    .flatMap((entry) => Object.values(entry.models))
    .find(
      (model) =>
        hasPrice(model) &&
        (model.id === modelID || normalizedModelID(model.id) === normalized),
    );
}

export function estimateCost(
  messages: ReadonlyArray<CostMessage>,
  providers: ReadonlyArray<Provider>,
): number {
  let total = 0;
  for (const message of messages) {
    const model = pricingFor(providers, message.providerID, message.modelID);
    if (!model) continue;

    const tokens = message.tokens;
    const contextTokens = tokens.input + tokens.cache.read + tokens.cache.write;
    const cost =
      model.cost.tiers
        ?.filter(
          (entry) => entry.tier.type === "context" && contextTokens > entry.tier.size,
        )
        .sort((a, b) => b.tier.size - a.tier.size)[0] ??
      (model.cost.experimentalOver200K && contextTokens > 200_000
        ? model.cost.experimentalOver200K
        : model.cost);

    total +=
      (tokens.input * cost.input +
        (tokens.output + tokens.reasoning) * cost.output +
        tokens.cache.read * cost.cache.read +
        tokens.cache.write * cost.cache.write) /
      1_000_000;
  }
  return total;
}

export function combineCosts(
  reportedCost: number,
  messages: ReadonlyArray<CostMessage>,
  providers: ReadonlyArray<Provider>,
): { cost: number; mode: CostMode } {
  const estimatedCost = estimateCost(
    messages.filter((message) => message.cost === 0),
    providers,
  );
  return {
    cost: reportedCost + estimatedCost,
    mode:
      estimatedCost > 0
        ? reportedCost > 0
          ? "mixed"
          : "estimated"
        : "reported",
  };
}

export function isAssistant(m: Message): m is AssistantMessage {
  return m.role === "assistant";
}

export function computeTotals(messages: ReadonlyArray<Message>): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const m of messages) {
    if (!isAssistant(m)) continue;
    t.input += m.tokens.input;
    t.output += m.tokens.output;
    t.reasoning += m.tokens.reasoning;
    t.cacheRead += m.tokens.cache.read;
    t.cacheWrite += m.tokens.cache.write;
    t.cost += m.cost ?? 0;
    t.turns += 1;
  }
  return t;
}

export function sumSessions(
  sessions: ReadonlyArray<Session>,
  turns: number,
): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const s of sessions) {
    const tk = s.tokens;
    if (!tk) continue;
    t.input += tk.input;
    t.output += tk.output;
    t.reasoning += tk.reasoning;
    t.cacheRead += tk.cache.read;
    t.cacheWrite += tk.cache.write;
    t.cost += s.cost ?? 0;
  }
  t.turns = turns;
  return t;
}

export async function mapWithConcurrency<Input, Output>(
  items: ReadonlyArray<Input>,
  worker: (item: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let next = 0;
  const count = Math.min(FETCH_CONCURRENCY, items.length);

  await Promise.all(
    Array.from({ length: count }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]!);
      }
    }),
  );

  return results;
}

export async function fetchDescendants(
  client: OpencodeClient,
  rootID: string,
): Promise<DescendantData> {
  const out: Session[] = [];
  const visited = new Set([rootID]);
  let level = [rootID];

  while (level.length > 0) {
    const childLists = await mapWithConcurrency(level, async (sessionID) => {
      const res = await client.session.children({ sessionID });
      return res.data ?? [];
    });
    const nextLevel: string[] = [];

    for (const children of childLists) {
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        out.push(child);
        nextLevel.push(child.id);
      }
    }
    level = nextLevel;
  }

  const messages = await mapWithConcurrency(out, async (session) => {
    const res = await client.session.messages({ sessionID: session.id });
    return res.data ?? [];
  });
  const turns = messages.flat().filter((message) => isAssistant(message.info)).length;

  return { sessions: out, turns };
}
