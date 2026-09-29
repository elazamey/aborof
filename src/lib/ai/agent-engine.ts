import { redactSecrets } from "@/lib/errors";
import { metrics } from "@/lib/observability/metrics";
import { extractProductCards, type ProductCard } from "./cards";
import { resolveProviderOrder, type ProviderName } from "./chain-order";
import { getMcpRegistry, isMcpToolsEnabled } from "./mcp";
import { AiGatewayProvider } from "./providers/ai-gateway";
import { GeminiRestProvider } from "./providers/gemini-rest";
import { GroqProvider } from "./providers/groq";
import { LocalFallbackProvider } from "./providers/local-fallback";
import { NvidiaNimProvider } from "./providers/nvidia-nim";
import { runToolLoop } from "./tools/run-tool-loop";
import type { ToolCapableProvider } from "./tools/types";
import type { AgentMessage, AgentOptions, AgentResult, AIAgentProvider } from "./types";

/**
 * محرك الوكيل الذكي — سلسلة تراجع محكمة (المحرك الصامت):
 *   Gemini ← Groq ← NVIDIA NIM ← AI Gateway ← الرد المحلي.
 *
 *  - كل فشل أو رد فارغ ينتقل صامتًا للمزود التالي (لا 500 للمستخدم).
 *  - كل فشل يُسجَّل في المقاييس مع رسالة محجوبة الأسرار.
 *  - طبقة حماية إضافية لعلم الميزة: إن وصل المحرك والعلم غير مفعّل
 *    فالجواب محلي فورًا (المسار الأساسي للعلم ما زال عند نقطة الاستدعاء).
 *  - المرحلة الثانية: عندما تُفعَّل طبقة MCP **و** يطلب المستدعي الأدوات
 *    **و** كان المزود قادرًا عليها، تُشغَّل دورة أدوات محدودة السقف عبر
 *    `McpToolRegistry`. أي مزود لا يدعم الأدوات يبقى على مساره النصي نفسه.
 *  - ‏AI Gateway أُضيف في آخر السلسلة قبل الرد المحلي، فلا يُطلب إلا بعد
 *    سقوط كل ما قبله (صفر كسر لأي تكوين قائم).
 *
 * يقبل المحرك قائمة مزودين اختيارية لحقن التبعيات في الاختبارات.
 */

/**
 * يبني قائمة المزودين الافتراضية وفق الترتيب المطلوب (بيئة أو افتراضي).
 * الرد المحلي مضمون دائمًا في النهاية عبر `resolveProviderOrder`.
 */
function buildDefaultProviders(): AIAgentProvider[] {
  const pools: Record<ProviderName, AIAgentProvider> = {
    gemini: new GeminiRestProvider(),
    groq: new GroqProvider(),
    "nvidia-nim": new NvidiaNimProvider(),
    "ai-gateway": new AiGatewayProvider(),
    local: new LocalFallbackProvider(),
  };
  return resolveProviderOrder().map((name) => pools[name]);
}

export class SmartAgentEngine {
  private readonly providers: AIAgentProvider[];

  constructor(providers?: AIAgentProvider[]) {
    // عند حقن مزودين في الاختبارات يُحترَم ترتيبهم كما هو.
    if (providers) {
      this.providers = providers;
      return;
    }
    this.providers = buildDefaultProviders();
  }

  /** يعالج الطلب ويعيد الرد مع اسم المزود الذي قدّمه (للمراقبة والشفافية). */
  async processRequestDetailed(
    messages: AgentMessage[],
    options?: AgentOptions
  ): Promise<AgentResult> {
    // فحص علم الميزة — تعطيل المحرك يعني ردًا محليًا فوريًا.
    if (process.env.ENABLE_AI_AGENT !== "true") {
      return {
        reply: await new LocalFallbackProvider().generateResponse(messages, options),
        provider: "local",
      };
    }

    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;
      try {
        const outcome = await this.invokeProvider(provider, messages, options);
        if (outcome.reply.trim()) {
          const result: AgentResult = { reply: outcome.reply, provider: provider.name };
          if (outcome.toolCalls > 0) result.toolCalls = outcome.toolCalls;
          // البطاقات تُضاف فقط إن أنتجتها أداة ناجحة، وتبقى الواجهة تعمل بدونها.
          if (outcome.products.length > 0) result.products = outcome.products;
          return result;
        }
      } catch (e) {
        metrics.recordAiFailure(provider.name);
        console.error(
          `ai engine: ${provider.name} failed:`,
          redactSecrets(String((e as Error)?.message ?? e))
        );
      }
    }

    // حارس أخير نظريًا فقط: المزود المحلي في السلسلة الافتراضية متاح دائمًا.
    return { reply: "عذرًا، الخدمة غير متاحة حاليًا. يرجى المحاولة لاحقًا.", provider: "none" };
  }

  /** الواجهة البسيطة: نص الرد فقط. */
  async processRequest(messages: AgentMessage[], options?: AgentOptions): Promise<string> {
    return (await this.processRequestDetailed(messages, options)).reply;
  }

  /**
   * مسار واحد لكل مزود: دورة أدوات إن كان الطلب والأداة والمزود متاحين،
   * وإلا المسار النصي القديم حرفيًا. أي فشل يرمي للأعلى لتستمر السلسلة الصامتة.
   */
  private async invokeProvider(
    provider: AIAgentProvider,
    messages: AgentMessage[],
    options?: AgentOptions
  ): Promise<{ reply: string; toolCalls: number; products: ProductCard[] }> {
    const capable = provider as Partial<ToolCapableProvider>;
    // Celia تُفعّل أدواتها عبر ENABLE_CELIA_AGENT حتى لو كانت MCP معطلة
    // — Scope Filter هو البوابة، والتنفيذ المزدوج يرفض أي تجاوز.
    let celiaEnabled = false;
    try {
      const mod = require("@/lib/celia/config") as { isCeliaAgentEnabled?: () => boolean };
      celiaEnabled = mod.isCeliaAgentEnabled?.() === true;
    } catch {
      celiaEnabled = false;
    }
    const toolsRequested =
      options?.enableTools === true &&
      (isMcpToolsEnabled() || celiaEnabled) &&
      capable.supportsTools === true &&
      typeof capable.callWithTools === "function";

    if (toolsRequested) {
      const { reply, toolCalls, structured } = await runToolLoop({
        provider: capable as ToolCapableProvider,
        messages,
        options,
        registry: getMcpRegistry(),
      });
      return { reply, toolCalls, products: extractProductCards(structured) };
    }

    return { reply: await provider.generateResponse(messages, options), toolCalls: 0, products: [] };
  }
}
