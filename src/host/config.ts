export interface LumeConfig {
	sampleCount?: number;
	sampleMin?: number;
	personaOrder?: number;
	memoryInject?: number;
	styleInject?: number;
	injectionStrategy?: "topk" | "full";
	extractionEnabled?: boolean;
	extractionCooldownMs?: number;
	extractionProvider?: string;
	extractionModel?: string;
	distillProvider?: string;
	distillModel?: string;
	switchBoundaryTurns?: number;
	layeredInjection?: boolean;
}
