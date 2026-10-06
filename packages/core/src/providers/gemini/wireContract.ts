/**
 * The fields of the Gemini API request types this adapter writes, extracted from
 * the public discovery document
 * (https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta,
 * fetched 2026-10-03). wire.contract.test.ts checks every request body the adapter
 * builds against it, so a misspelled or unsupported field fails a test instead of
 * a user's request. Not imported by production code.
 *
 * Entries: `ref` names the schema a field holds (`type: 'array'` or `'map'`: a list
 * or string-keyed map of it); `enum` lists the legal values of a string field.
 */
export interface ContractField {
  type?: string
  ref?: string
  enum?: string[]
}

export const GEMINI_WIRE_CONTRACT: Record<string, Record<string, ContractField>> = {
  GenerateContentRequest: {generationConfig:{ref:'GenerationConfig'},cachedContent:{type:'string'},contents:{type:'array',ref:'Content'},tools:{type:'array',ref:'Tool'},toolConfig:{ref:'ToolConfig'},store:{type:'boolean'},systemInstruction:{ref:'Content'},serviceTier:{type:'string',enum:['unspecified','standard','flex','priority']},safetySettings:{type:'array'},model:{type:'string'},labels:{type:'object'}},
  Content: {role:{type:'string'},parts:{type:'array',ref:'Part'}},
  Part: {functionResponse:{ref:'FunctionResponse'},codeExecutionResult:{},executableCode:{},audioTranscription:{},inlineData:{ref:'Blob'},partMetadata:{type:'object'},toolResponse:{},thought:{type:'boolean'},speechMetadata:{},videoMetadata:{},text:{type:'string'},toolCall:{},mediaProcessing:{type:'string',enum:['MEDIA_PROCESSING_UNSPECIFIED','STATIC','AGENTIC']},functionCall:{ref:'FunctionCall'},fileData:{ref:'FileData'},thoughtSignature:{type:'string'},mediaResolution:{}},
  Blob: {data:{type:'string'},mimeType:{type:'string'},displayName:{type:'string'}},
  FileData: {fileUri:{type:'string'},mimeType:{type:'string'},displayName:{type:'string'}},
  FunctionCall: {name:{type:'string'},id:{type:'string'},args:{type:'object'}},
  FunctionResponse: {willContinue:{type:'boolean'},name:{type:'string'},response:{type:'object'},parts:{type:'array'},scheduling:{type:'string',enum:['SCHEDULING_UNSPECIFIED','SILENT','WHEN_IDLE','INTERRUPT']},id:{type:'string'}},
  Tool: {codeExecution:{},googleSearchRetrieval:{},fileSearch:{},googleMaps:{},googleSearch:{},urlContext:{},computerUse:{},mcpServers:{type:'array'},functionDeclarations:{type:'array',ref:'FunctionDeclaration'}},
  FunctionDeclaration: {name:{type:'string'},parametersJsonSchema:{type:'any'},description:{type:'string'},behavior:{type:'string',enum:['UNSPECIFIED','BLOCKING','NON_BLOCKING']},response:{ref:'Schema'},responseJsonSchema:{type:'any'},parameters:{ref:'Schema'}},
  Schema: {propertyOrdering:{type:'array'},format:{type:'string'},maxItems:{type:'string'},pattern:{type:'string'},description:{type:'string'},example:{type:'any'},properties:{type:'map',ref:'Schema'},maximum:{type:'number'},minLength:{type:'string'},enum:{type:'array'},default:{type:'any'},type:{type:'string',enum:['TYPE_UNSPECIFIED','STRING','NUMBER','INTEGER','BOOLEAN','ARRAY','OBJECT','NULL']},title:{type:'string'},required:{type:'array'},maxLength:{type:'string'},minProperties:{type:'string'},maxProperties:{type:'string'},nullable:{type:'boolean'},minimum:{type:'number'},items:{ref:'Schema'},anyOf:{type:'array',ref:'Schema'},minItems:{type:'string'}},
  ToolConfig: {includeServerSideToolInvocations:{type:'boolean'},retrievalConfig:{},functionCallingConfig:{ref:'FunctionCallingConfig'}},
  FunctionCallingConfig: {allowedFunctionNames:{type:'array'},mode:{type:'string',enum:['MODE_UNSPECIFIED','AUTO','ANY','NONE','VALIDATED']}},
  GenerationConfig: {thinkingConfig:{ref:'ThinkingConfig'},stopSequences:{type:'array'},_responseJsonSchema:{type:'any'},responseLogprobs:{type:'boolean'},maxOutputTokens:{type:'integer'},frequencyPenalty:{type:'number'},topK:{type:'integer'},temperature:{type:'number'},responseModalities:{type:'array'},responseMimeType:{type:'string'},speechConfig:{},responseFormat:{},translationConfig:{},candidateCount:{type:'integer'},logprobs:{type:'integer'},enableAffectiveDialog:{type:'boolean'},topP:{type:'number'},enableEnhancedCivicAnswers:{type:'boolean'},mediaResolution:{type:'string',enum:['MEDIA_RESOLUTION_UNSPECIFIED','MEDIA_RESOLUTION_LOW','MEDIA_RESOLUTION_MEDIUM','MEDIA_RESOLUTION_HIGH']},audioTranscriptionConfig:{},imageConfig:{},presencePenalty:{type:'number'},seed:{type:'integer'},responseJsonSchema:{type:'any'},responseSchema:{ref:'Schema'}},
  ThinkingConfig: {thinkingLevel:{type:'string',enum:['THINKING_LEVEL_UNSPECIFIED','MINIMAL','LOW','MEDIUM','HIGH']},includeThoughts:{type:'boolean'},thinkingBudget:{type:'integer'}}
}
