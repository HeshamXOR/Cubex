/**
 * Capability flags. Providers/models advertise what they support so the UI and
 * gateway can degrade gracefully instead of sending invalid requests.
 */
export type Capability =
  | 'text' // basic text generation
  | 'streaming' // server-sent streaming of deltas
  | 'system_prompt' // dedicated system/developer prompt
  | 'multi_turn' // conversation history
  | 'tools' // function / tool calling
  | 'structured_output' // JSON schema constrained output
  | 'json_mode' // loose JSON object mode
  | 'reasoning' // exposes reasoning/thinking tokens
  | 'vision' // understands images
  | 'image_input'
  | 'file_input'
  | 'audio_input'
  | 'video_input'
  | 'audio_output'
  | 'temperature' // honors sampling temperature
  | 'stop_sequences'
  | 'usage_reporting' // returns token usage
  | 'cancellation' // supports mid-request abort

export const ALL_CAPABILITIES: Capability[] = [
  'text',
  'streaming',
  'system_prompt',
  'multi_turn',
  'tools',
  'structured_output',
  'json_mode',
  'reasoning',
  'vision',
  'image_input',
  'file_input',
  'audio_input',
  'video_input',
  'audio_output',
  'temperature',
  'stop_sequences',
  'usage_reporting',
  'cancellation'
]
