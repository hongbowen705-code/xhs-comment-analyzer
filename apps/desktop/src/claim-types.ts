export const CLAIM_TYPES = [
  "product_or_service_effect",
  "price_or_transaction",
  "health_or_safety",
  "policy_or_platform_rule",
  "identity_or_qualification",
  "event_or_timeline",
  "statistic_or_scale",
  "causal_relationship",
  "other_verifiable_claim"
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];
export type ClaimVerificationStatus = "unverified";

export const DEFAULT_CLAIM_TYPE: ClaimType = "other_verifiable_claim";

export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  product_or_service_effect: "产品或服务效果",
  price_or_transaction: "价格或交易信息",
  health_or_safety: "健康或安全",
  policy_or_platform_rule: "政策、规则或平台机制",
  identity_or_qualification: "身份、资质或主体信息",
  event_or_timeline: "事件或时间线",
  statistic_or_scale: "数据、比例或规模",
  causal_relationship: "因果关系",
  other_verifiable_claim: "其他可核验声明"
};

export function isClaimType(value: unknown): value is ClaimType {
  return typeof value === "string" && CLAIM_TYPES.includes(value as ClaimType);
}
