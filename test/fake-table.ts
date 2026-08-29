/**
 * 内存假表：模拟 dsh-storage-json 的插入序语义（put 已存在键不移动位置），
 * 供 PersonaStore / RPC 的单测使用。真实后端行为另见 integration.storage.test.ts。
 */
export class FakePersonaTable {
	readonly map = new Map<string, unknown>();

	get(key: string): unknown {
		return this.map.get(key);
	}

	keys(): IterableIterator<string> {
		return this.map.keys();
	}

	get size(): number {
		return this.map.size;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.map.set(key, value);
	}

	async delete(key: string): Promise<boolean> {
		return this.map.delete(key);
	}
}
