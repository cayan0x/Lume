/**
 * 会话事件处理链路的**依赖契约**（架构整理 ①⑤：边界类型化 + 契约独立成模块）。
 *
 * 为什么单独成文件：事件分发（session-events）、轮边界（turn-boundary）、disposed 收尾共用同一份
 * 依赖；契约放在使用方之一里会让另一个反向依赖它（成环）。这里只有类型，没有运行时依赖。
 *
 * 分组按**域**（env / notice / carrier / signal / prompt / tool / agent），组合用 extends；
 * 访问保持扁平（deps.contractOf），所以分组不增加调用点噪音。
 */
import * as citationsMod from "../core/citations.js";
import * as leakMod from "../core/leak-detector.js";
import * as ledgerMod from "../core/ledger.js";
import * as signalsMod from "../core/signals.js";
import * as textMod from "../core/text.js";
import * as knowledgeMod from "../core/knowledge.js";
import * as compactionMod from "./compaction.js";
import * as diagMod from "./diag.js";
import * as extractionMod from "./extraction.js";
import * as hostEventsMod from "./host-events.js";
import * as methodsMod from "./methods.js";
import * as noticesMod from "./notices.js";
import * as protocolMod from "./protocol.js";
import * as reflectionMod from "./reflection.js";
import * as thinkingMod from "./thinking.js";
import * as triggersMod from "./triggers.js";
import { handleTurnEnd } from "./turn-boundary.js";
