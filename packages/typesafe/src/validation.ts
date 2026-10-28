import { assertJson, fail, immutable, requireId } from "@tessar/core";
import { TypeSafeResponseError } from "./errors.js";
import type { Questions, TypeSafeRequest, TypeSafeResponse } from "./types.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const content = (value: unknown) =>
  typeof value === "string" || object(value) || Array.isArray(value);
const fraction = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const probabilities = (value: unknown) =>
  object(value) && Object.values(value).every(fraction);
const invalid = (message: string): never =>
  fail("InvalidConfiguration", message);

export function prepareRequest<Q extends Questions>(
  input: TypeSafeRequest<Q>,
  model?: string,
) {
  if (!object(input))
    invalid("generate requires an object containing state and questions");
  const selected = requireId(input.model ?? model!, "TypeSafe model");
  if (!content(input.state))
    invalid("state must be text, a JSON object or an array");
  if (!object(input.questions) || !Object.keys(input.questions).length)
    invalid("questions must be a nonempty object");
  const request = {
    model: selected,
    state: input.state,
    questions: input.questions,
    ...(input.assets !== undefined ? { assets: input.assets } : {}),
  };
  assertJson(request);
  for (const question of Object.values(input.questions)) {
    if (!object(question)) invalid("Each question must be an object");
    if (
      question.instructions !== undefined &&
      question.instructions !== null &&
      !content(question.instructions)
    )
      invalid(
        "Question instructions must be text, an object, an array or null",
      );
    switch (question.type) {
      case "noul":
        if (
          question.criteria !== undefined &&
          question.criteria !== null &&
          (!object(question.criteria) ||
            Object.entries(question.criteria).some(
              ([key, value]) =>
                !["true", "false"].includes(key) ||
                (value !== null && !content(value)),
            ))
        )
          invalid("noul criteria must describe true and/or false");
        break;
      case "choice":
        if (
          !object(question.criteria) ||
          !Object.keys(question.criteria).length ||
          Object.keys(question.criteria).length > 255 ||
          Object.values(question.criteria).some(
            (value) => value !== null && !content(value),
          )
        )
          invalid("choice criteria must contain 1–255 descriptions");
        break;
      case "score":
        if (
          !Array.isArray(question.criteria) ||
          question.criteria.length < 1 ||
          question.criteria.length > 10 ||
          !question.criteria.every(content)
        )
          invalid("score criteria must contain 1–10 descriptions");
        break;
      case "box":
        break;
      default:
        invalid("Unsupported question type");
    }
  }
  if (input.assets !== undefined) {
    if (!object(input.assets) || !Object.keys(input.assets).length)
      invalid("assets must be a nonempty object");
    for (const asset of Object.values(input.assets))
      if (
        !object(asset) ||
        asset.type !== "image" ||
        !["png", "jpg", "jpeg"].includes(asset.format) ||
        typeof asset.data_base64 !== "string" ||
        !asset.data_base64 ||
        "part" in asset
      )
        invalid(
          "Use inline png/jpg/jpeg data_base64 assets; multipart assets are not supported",
        );
  }
  return immutable(request);
}

export function validateResponse<Q extends Questions>(
  value: unknown,
  questions: Q,
  raw: string,
): asserts value is TypeSafeResponse<Q> {
  const bad: () => never = () => {
    throw new TypeSafeResponseError("Invalid TypeSafe response", raw);
  };
  try {
    assertJson(value);
  } catch {
    bad();
  }
  if (
    !object(value) ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !object(value.answers) ||
    !object(value.usage)
  )
    bad();
  for (const token of [value.usage.input_tokens, value.usage.output_tokens])
    if (typeof token !== "number" || !Number.isSafeInteger(token) || token < 0)
      bad();
  for (const [name, question] of Object.entries(questions)) {
    if (!Object.hasOwn(value.answers, name)) bad();
    const answer = value.answers[name];
    if (!object(answer) || answer.type !== question.type) bad();
    switch (question.type) {
      case "noul":
        if (!fraction(answer.noul)) bad();
        break;
      case "choice":
        if (
          typeof answer.choice !== "string" ||
          !Object.hasOwn(question.criteria, answer.choice) ||
          !fraction(answer.confidence) ||
          !probabilities(answer.probabilities) ||
          !Object.keys(question.criteria).every((key) =>
            Object.hasOwn(answer.probabilities as object, key),
          )
        )
          bad();
        break;
      case "score":
        if (
          typeof answer.score !== "number" ||
          !Number.isFinite(answer.score) ||
          answer.score < 0 ||
          answer.score > question.criteria.length - 1 ||
          !fraction(answer.confidence) ||
          !probabilities(answer.probabilities) ||
          !object(answer.legend) ||
          !Object.values(answer.legend).every(content)
        )
          bad();
        break;
      case "box": {
        const box = answer.box;
        if (
          !object(box) ||
          !["top", "bottom", "left", "right"].every((key) =>
            fraction(box[key]),
          ) ||
          (answer.confidence !== null && !fraction(answer.confidence))
        )
          bad();
        break;
      }
    }
  }
}
