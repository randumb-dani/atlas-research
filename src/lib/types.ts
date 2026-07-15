export interface LMModel {
  type: "llm" | "embedding";
  publisher: string;
  key: string;
  display_name: string;
  architecture: string | null;
  quantization: {
    name: string | null;
    bits_per_weight: number | null;
  } | null;
  size_bytes: number;
  params_string: string | null;
  loaded_instances: LoadedInstance[];
  max_context_length: number;
  format: "gguf" | "mlx" | null;
  capabilities?: {
    vision: boolean;
    trained_for_tool_use: boolean;
    reasoning?: {
      allowed_options: string[];
      default: string;
    };
  };
  description: string | null;
  variants?: string[];
  selected_variant?: string;
}

export interface LoadedInstance {
  id: string;
  config: {
    context_length: number;
    eval_batch_size?: number;
    parallel?: number;
    flash_attention?: boolean;
    num_experts?: number;
    offload_kv_cache_to_gpu?: boolean;
  };
}

export interface ModelsResponse {
  models: LMModel[];
}

export interface LoadRequest {
  model: string;
  context_length?: number;
  flash_attention?: boolean;
  num_experts?: number;
  offload_kv_cache_to_gpu?: boolean;
  echo_load_config?: boolean;
}

export interface LoadResponse {
  type: "llm" | "embedding";
  instance_id: string;
  load_time_seconds: number;
  status: "loaded";
  load_config?: Record<string, unknown>;
}

export interface UnloadRequest {
  instance_id: string;
}

export interface UnloadResponse {
  instance_id: string;
}

export interface ChatRequest {
  model: string;
  input: string | { type: string; content: string }[];
  system_prompt?: string;
  integrations?: Integration[];
  stream?: boolean;
  temperature?: number;
  context_length?: number;
  previous_response_id?: string;
  store?: boolean;
  max_output_tokens?: number;
  reasoning?: "off" | "low" | "medium" | "high" | "on";
}

export interface Integration {
  type: "ephemeral_mcp" | "plugin";
  server_label?: string;
  server_url?: string;
  allowed_tools?: string[];
  id?: string;
}

export interface ChatResponse {
  model_instance_id: string;
  output: ChatOutputItem[];
  stats: ChatStats;
  response_id?: string;
}

export type ChatOutputItem =
  | MessageOutput
  | ToolCallOutput
  | ReasoningOutput
  | InvalidToolCallOutput;

export interface MessageOutput {
  type: "message";
  content: string;
}

export interface ToolCallOutput {
  type: "tool_call";
  tool: string;
  arguments: Record<string, unknown>;
  output: string;
  provider_info: {
    type: "plugin" | "ephemeral_mcp";
    plugin_id?: string;
    server_label?: string;
  };
}

export interface ReasoningOutput {
  type: "reasoning";
  content: string;
}

export interface InvalidToolCallOutput {
  type: "invalid_tool_call";
  reason: string;
  metadata: {
    type: "invalid_name" | "invalid_arguments";
    tool_name: string;
    arguments?: Record<string, unknown>;
  };
}

export interface ChatStats {
  input_tokens: number;
  total_output_tokens: number;
  reasoning_output_tokens: number;
  tokens_per_second: number;
  time_to_first_token_seconds: number;
  model_load_time_seconds?: number;
}

export type SSEEvent =
  | { type: "chat.start"; model_instance_id: string }
  | { type: "model_load.start"; model_instance_id: string }
  | { type: "model_load.progress"; model_instance_id: string; progress: number }
  | { type: "model_load.end"; model_instance_id: string; load_time_seconds: number }
  | { type: "prompt_processing.start" }
  | { type: "prompt_processing.progress"; progress: number }
  | { type: "prompt_processing.end" }
  | { type: "reasoning.start" }
  | { type: "reasoning.delta"; content: string }
  | { type: "reasoning.end" }
  | { type: "tool_call.start"; tool: string; provider_info: Record<string, unknown> }
  | { type: "tool_call.arguments"; tool: string; arguments: Record<string, unknown> }
  | { type: "tool_call.success"; tool: string; arguments: Record<string, unknown>; output: string }
  | { type: "tool_call.failure"; reason: string; metadata: Record<string, unknown> }
  | { type: "message.start" }
  | { type: "message.delta"; content: string }
  | { type: "message.end" }
  | { type: "error"; error: { type: string; message: string; code?: string; param?: string } }
  | { type: "chat.end"; result: ChatResponse };

export interface SSEErrorEvent {
  type: "error";
  error: { type: string; message: string };
}
