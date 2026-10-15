import { z } from "zod";

import {
  isKnowledgeDocumentApplicable,
  searchKnowledge,
  type KnowledgeSnapshot,
} from "./knowledge-store.js";

export type KnowledgeKind = "PRODUCT_DOC" | "HISTORICAL_CASE";
export type KnowledgeDocument = KnowledgeSnapshot["documents"][number];

export interface KnowledgeSearchRequest {
  snapshot: KnowledgeSnapshot;
  kind: KnowledgeKind;
  query: string;
  maxResults?: number;
}

export interface KnowledgeRetriever {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeDocument[]>;
}

export const createInMemoryKnowledgeRetriever = (): KnowledgeRetriever => ({
  async search({ snapshot, kind, query, maxResults }) {
    return searchKnowledge(snapshot, kind, query, maxResults);
  },
});

const raftHitSchema = z
  .object({
    knowledge_id: z.string().min(1),
    version: z.string().min(1),
    score: z.number().finite(),
  })
  .strict();

export interface RaftRetrievalRequest {
  snapshot_id: string;
  kind: KnowledgeKind;
  query: string;
  max_results: number;
  product_context: KnowledgeSnapshot["product_context"];
}

export interface RaftRetrievalClient {
  search(request: RaftRetrievalRequest): Promise<unknown>;
}

const referenceKey = (knowledgeId: string, version: string): string =>
  JSON.stringify([knowledgeId, version]);

export const createRaftKnowledgeRetriever = (
  client: RaftRetrievalClient,
): KnowledgeRetriever => ({
  async search({ snapshot, kind, query, maxResults = 5 }) {
    const boundedMaxResults = Math.max(1, Math.min(maxResults, 10));
    const hits = z.array(raftHitSchema).parse(
      await client.search({
        snapshot_id: snapshot.snapshot_id,
        kind,
        query,
        max_results: boundedMaxResults,
        product_context: snapshot.product_context,
      }),
    );
    const approvedDocuments = new Map(
      snapshot.documents
        .filter(
          (document) =>
            document.kind === kind &&
            isKnowledgeDocumentApplicable(snapshot, document),
        )
        .map((document) => [
          referenceKey(document.knowledge_id, document.version),
          document,
        ]),
    );
    const selected: KnowledgeDocument[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const key = referenceKey(hit.knowledge_id, hit.version);
      const document = approvedDocuments.get(key);
      if (!document || seen.has(key)) continue;
      selected.push(document);
      seen.add(key);
      if (selected.length === boundedMaxResults) break;
    }
    return selected;
  },
});
