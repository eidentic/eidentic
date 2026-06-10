import { embed, embedMany } from "ai";
import type { EmbeddingPort } from "@eidentic/types";

/** The embedding-model type accepted by AI SDK v6 `embed`, minus the bare-string branch. */
type AIEmbeddingModel = Exclude<Parameters<typeof embed>[0]["model"], string>;

/**
 * Provider-agnostic hosted embedder over AI SDK v6. Bring your own provider + key + model:
 *   const embedder = await AIEmbedder.create(openai.embedding("text-embedding-3-small"));
 * Works with any `@ai-sdk/*` embedding model (OpenAI, Cohere, Google, Mistral, ...).
 * A first-class peer to the local `@eidentic/transformers` embedder; pick whichever fits.
 */
export class AIEmbedder implements EmbeddingPort {
  readonly dim: number;
  private constructor(private readonly model: AIEmbeddingModel, dim: number) {
    this.dim = dim;
  }

  /** Construct an embedder, probing the model once to discover its output dimension. */
  static async create(model: AIEmbeddingModel): Promise<AIEmbedder> {
    const { embedding } = await embed({ model, value: "x" });
    return new AIEmbedder(model, embedding.length);
  }

  async embed(text: string): Promise<number[]> {
    const { embedding } = await embed({ model: this.model, value: text });
    return embedding;
  }

  /**
   * Batch embedding via AI SDK v6 `embedMany({ model, values })` → `{ embeddings: number[][] }`.
   * Embeds all texts in a single provider call (fewer round-trips on the ingest hot path).
   * Each returned vector is validated to have length === `this.dim`.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { embeddings } = await embedMany({ model: this.model, values: texts });
    for (let i = 0; i < embeddings.length; i++) {
      if (embeddings[i]!.length !== this.dim) {
        throw new Error(`embedBatch: embedding[${i}] has length ${embeddings[i]!.length}, expected ${this.dim}`);
      }
    }
    return embeddings as number[][];
  }
}
