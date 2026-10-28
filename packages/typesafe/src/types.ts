import type { JsonObject, JsonValue, RecordStore, Scope } from "@tessar/core";

export type TypeSafeState = string | JsonObject | readonly JsonValue[];
export type QuestionContent = TypeSafeState | null;
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions?: QuestionContent;
  readonly criteria?: {
    readonly true?: QuestionContent;
    readonly false?: QuestionContent;
  } | null;
}
export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions?: QuestionContent;
  readonly criteria: Readonly<Record<string, QuestionContent>>;
}
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions?: QuestionContent;
  readonly criteria: readonly TypeSafeState[];
}
export interface BoxQuestion {
  readonly type: "box";
  readonly instructions?: QuestionContent;
}
export type Question =
  | NoulQuestion
  | ChoiceQuestion
  | ScoreQuestion
  | BoxQuestion;
export type Questions = Readonly<Record<string, Question>>;
export interface ImageAsset {
  readonly type: "image";
  readonly format: "png" | "jpg" | "jpeg";
  readonly data_base64: string;
}
export interface TypeSafeRequest<Q extends Questions = Questions> {
  readonly model?: string;
  readonly state: TypeSafeState;
  readonly questions: Q;
  readonly assets?: Readonly<Record<string, ImageAsset>>;
}
export interface TypeSafeOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  records?: RecordStore;
  headers?: Readonly<Record<string, string>>;
}
export interface TypeSafeGenerateOptions {
  id?: string;
  scope?: Scope;
  metadata?: JsonObject;
  signal?: AbortSignal;
}
export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}
export interface ChoiceAnswer<K extends string = string> {
  readonly type: "choice";
  readonly choice: K;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<K, number>>;
}
export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly legend: Readonly<Record<string, TypeSafeState>>;
  readonly probabilities: Readonly<Record<string, number>>;
}
export interface BoxAnswer {
  readonly type: "box";
  readonly box: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
  readonly confidence: number | null;
}
export type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion
    ? ChoiceAnswer<Extract<keyof Q["criteria"], string>>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : BoxAnswer;
export interface TypeSafeResponse<Q extends Questions = Questions> {
  readonly model: string;
  readonly answers: { readonly [K in keyof Q]: AnswerFor<Q[K]> };
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}
