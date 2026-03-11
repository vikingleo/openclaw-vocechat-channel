declare module "openclaw/plugin-sdk" {
  export const createNormalizedOutboundDeliverer: any;
  export const createReplyPrefixOptions: any;
  export const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS: number;
  export const DEFAULT_WEBHOOK_MAX_BODY_BYTES: number;
  export const formatTextWithAttachmentLinks: any;
  export const loadOutboundMediaFromUrl: any;
  export const readJsonBodyWithLimit: any;
  export const registerPluginHttpRoute: any;
  export const resolveOutboundMediaUrls: any;
  export const writeJsonFileAtomically: any;

  export type ChannelOutboundContext = any;
  export type ChannelPlugin<T = any> = any;
  export type OpenClawConfig = any;
  export type OpenClawPluginApi = any;
  export type OutboundDeliveryResult = any;
  export type PluginCommandContext = any;
  export type PluginRuntime = any;
  export type ReplyPayload = any;
}
