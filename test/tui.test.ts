import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  Model,
  OpencodeClient,
  Provider,
  Session,
} from "@opencode-ai/sdk/v2";
import {
  combineCosts,
  computeTotals,
  estimateCost,
  fetchDescendants,
  sumSessions,
} from "../usage";

function assistant(id: string): AssistantMessage {
  return {
    id,
    sessionID: "root",
    role: "assistant",
    time: { created: 0 },
    parentID: "parent",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0.5,
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 10, write: 2 },
    },
  };
}

function session(id: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/",
    title: id,
    version: "1.17.9",
    cost: 1,
    tokens: {
      input: 50,
      output: 10,
      reasoning: 2,
      cache: { read: 3, write: 1 },
    },
    time: { created: 0, updated: 0 },
  };
}

function provider(id: string, model: Model): Provider {
  return {
    id,
    name: id,
    source: "api",
    env: [],
    options: {},
    models: { [model.id]: model },
  };
}

function pricedModel(
  id: string,
  providerID: string,
  cost: Model["cost"],
): Model {
  return {
    id,
    providerID,
    cost,
  } as Model;
}

function clientFor(
  children: Record<string, Session[]>,
  messages: Record<string, AssistantMessage[]>,
): OpencodeClient {
  return {
    session: {
      children: async ({ sessionID }: { sessionID: string }) => ({
        data: children[sessionID] ?? [],
      }),
      messages: async ({ sessionID }: { sessionID: string }) => ({
        data: (messages[sessionID] ?? []).map((info) => ({ info, parts: [] })),
      }),
    },
  } as unknown as OpencodeClient;
}

describe("token aggregation", () => {
  test("sums assistant messages and descendant session aggregates", () => {
    const root = computeTotals([assistant("root-1")]);
    const descendants = sumSessions([session("child")], 2);

    expect(root).toMatchObject({ input: 100, output: 20, turns: 1, cost: 0.5 });
    expect(descendants).toMatchObject({ input: 50, output: 10, turns: 2, cost: 1 });
  });
});

describe("cost estimation", () => {
  test("uses the same token categories and per-million rates as OpenCode", () => {
    const message = assistant("priced");
    message.cost = 0;
    message.modelID = "claude-opus-4-6";
    message.providerID = "anthropic";
    const model = pricedModel(message.modelID, message.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(estimateCost([message], [provider("anthropic", model)])).toBeCloseTo(
      0.0006855,
    );
  });

  test("finds API pricing across providers for quota-backed model aliases", () => {
    const message = assistant("quota");
    message.cost = 0;
    message.modelID = "claude-opus-4.6";
    message.providerID = "github-copilot";
    const quotaModel = pricedModel(message.modelID, message.providerID, {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    const apiModel = pricedModel("claude-opus-4-6", "anthropic", {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(
      estimateCost(
        [message],
        [
          provider("github-copilot", quotaModel),
          provider("anthropic", apiModel),
        ],
      ),
    ).toBeGreaterThan(0);
  });

  test("combines reported and estimated costs into one mixed total", () => {
    const reported = assistant("reported");
    const quota = assistant("quota");
    quota.cost = 0;
    quota.modelID = "claude-opus-4-6";
    quota.providerID = "anthropic";
    const model = pricedModel(quota.modelID, quota.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(
      combineCosts(reported.cost, [reported, quota], [provider("anthropic", model)]),
    ).toEqual({ cost: 0.5006855, mode: "mixed" });
  });

  test("marks a fully estimated total", () => {
    const quota = assistant("quota");
    quota.cost = 0;
    const model = pricedModel(quota.modelID, quota.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(combineCosts(0, [quota], [provider("provider", model)])).toEqual({
      cost: 0.0006855,
      mode: "estimated",
    });
  });

  test("does not estimate messages with an omitted cost", () => {
    const message = assistant("missing");
    delete (message as { cost?: number }).cost;
    const model = pricedModel(message.modelID, message.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(combineCosts(0.25, [message], [provider("provider", model)])).toEqual({
      cost: 0.25,
      mode: "reported",
    });
  });
});

describe("descendant fetching", () => {
  test("collects nested descendants once and counts their assistant turns", async () => {
    const child = session("child");
    const grandchild = session("grandchild");
    const client = clientFor(
      { root: [child], child: [grandchild], grandchild: [child] },
      { child: [assistant("child-1")], grandchild: [assistant("grandchild-1")] },
    );

    await expect(fetchDescendants(client, "root")).resolves.toEqual({
      sessions: [child, grandchild],
      turns: 2,
    });
  });

  test("fails the refresh when any descendant request fails", async () => {
    const client = clientFor({ root: [session("child")] }, {});
    const sessionApi = client.session as unknown as {
      messages: () => Promise<never>;
    };
    sessionApi.messages = async () => {
      throw new Error("unavailable");
    };

    await expect(fetchDescendants(client, "root")).rejects.toThrow("unavailable");
  });

  test("limits concurrent descendant requests", async () => {
    let active = 0;
    let peak = 0;
    const children: Record<string, Session[]> = {
      root: Array.from({ length: 8 }, (_, index) => session(`child-${index}`)),
    };
    const client = clientFor(children, {});
    const sessionApi = client.session as unknown as {
      children: ({ sessionID }: { sessionID: string }) => Promise<{ data: Session[] }>;
    };
    sessionApi.children = async ({ sessionID }) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return { data: children[sessionID] ?? [] };
    };

    await fetchDescendants(client, "root");
    expect(peak).toBeLessThanOrEqual(4);
  });
});
