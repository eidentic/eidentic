import { pipeline, AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";
import type { EmbeddingPort, RerankPort, VectorSearchResult } from "@eidentic/types";

/** Local zero-infra embedder over @huggingface/transformers (bge-small-en-v1.5, 384 dims). */
export class LocalEmbedder implements EmbeddingPort {
  readonly dim = 384;
  private constructor(private readonly extractor: (text: string | string[], opts: object) => Promise<{ tolist(): number[] | number[][] | number[][][] }>) {}

  static async load(modelId = "Xenova/bge-small-en-v1.5"): Promise<LocalEmbedder> {
    const extractor = (await pipeline("feature-extraction", modelId, { dtype: "fp32" })) as unknown as LocalEmbedder["extractor"];
    return new LocalEmbedder(extractor);
  }

  async embed(text: string): Promise<number[]> {
    const out = await this.extractor(text, { pooling: "mean", normalize: true });
    const list = out.tolist();
    return (Array.isArray(list[0]) ? (list as number[][])[0]! : (list as number[]));
  }

  /**
   * Batch embedding via the feature-extraction pipeline accepting an array of texts.
   * The pipeline returns shape [N, dim] (or [N, 1, dim] with pooling); we unwrap per row.
   * Each resulting vector is validated to have length === `this.dim`.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // The HuggingFace transformers pipeline accepts both a single string and a
    // string[], but its TypeScript signature declares only `string`.  We branch
    // explicitly so the cast is self-documenting and localised.
    const input: string | string[] = texts.length === 1 ? texts[0]! : texts;
    const out = await this.extractor(input as string, { pooling: "mean", normalize: true });
    const list = out.tolist();
    // list is number[][] (N rows × dim cols) after mean-pooling
    const rows: number[][] = Array.isArray(list[0]) ? (list as number[][]) : [list as number[]];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.length !== this.dim) {
        throw new Error(`LocalEmbedder.embedBatch: row[${i}] has length ${rows[i]!.length}, expected ${this.dim}`);
      }
    }
    return rows;
  }
}

/** Local cross-encoder reranker (opt-in). Uses AutoModel directly — the text-classification pipeline saturates scores. */
export class LocalReranker implements RerankPort {
  private constructor(
    private readonly tokenizer: (q: string, opts: object) => Promise<unknown>,
    private readonly model: (inputs: unknown) => Promise<{ logits: { data: Float32Array | number[] } }>,
  ) {}

  static async load(modelId = "mixedbread-ai/mxbai-rerank-xsmall-v1"): Promise<LocalReranker> {
    const tokenizer = (await AutoTokenizer.from_pretrained(modelId)) as unknown as LocalReranker["tokenizer"];
    const model = (await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: "fp32" })) as unknown as LocalReranker["model"];
    return new LocalReranker(tokenizer, model);
  }

  private async score(query: string, document: string): Promise<number> {
    const inputs = await this.tokenizer(query, { text_pair: document, padding: true, truncation: true });
    const { logits } = await this.model(inputs);
    const raw = logits.data[0] ?? 0;
    return 1 / (1 + Math.exp(-raw));
  }

  async rerank(query: string, candidates: VectorSearchResult[]): Promise<VectorSearchResult[]> {
    const scored = await Promise.all(candidates.map(async (c) => ({ ...c, score: await this.score(query, c.text) })));
    return scored.sort((a, b) => b.score - a.score);
  }
}
