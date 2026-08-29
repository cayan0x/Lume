/**
 * 人设资产的 IO 装载：manifest + 提示词 + 语料。
 *
 * 容错策略与 v0.1.0 一致：单个文件损坏只影响对应人设（空提示词/空语料），
 * manifest 本身损坏则整个人设表为空 —— 插件降级为「无人设可切」而非崩溃。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCorpus, parseManifest } from "../core/manifest.js";
import type { Persona, PersonaSample } from "../core/manifest.js";

/** manifest 中定义「不使用人设」的固定键名；默认人设语义依赖它存在。 */
export const NONE_PERSONA = "none";

/** 从资产目录加载人设表（保持 manifest 顺序）。 */
export function loadPersonalities(assetsDir: string): Record<string, Persona> {
	const result: Record<string, Persona> = {};
	let entries;
	try {
		entries = parseManifest(readFileSync(join(assetsDir, "personalities.json"), "utf8"));
	} catch {
		return result;
	}
	const personalitiesDir = join(assetsDir, "personalities");
	for (const entry of entries) {
		let promptText = "";
		try {
			promptText = readFileSync(join(personalitiesDir, entry.promptFile), "utf8").trim();
		} catch {
			promptText = "";
		}
		let corpus: PersonaSample[] = [];
		try {
			corpus = parseCorpus(readFileSync(join(personalitiesDir, entry.corpusFile), "utf8"));
		} catch {
			corpus = [];
		}
		result[entry.name] = {
			name: entry.name,
			displayName: entry.displayName,
			description: entry.description,
			promptText,
			corpus,
		};
	}
	return result;
}
