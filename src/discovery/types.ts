export interface DiscoveryEvent {
  v: number;
  standard: string;
  origin: string;
  url: string;
  via: 'link-header' | 'html-link' | 'well-known' | 'page-api' | 'response';
  page: string;
  targetId: string;
  status: 'valid' | 'invalid';
  summary: unknown;
  reason?: string;
}

export interface Candidate {
  id: string;
  endpoint: string;
  standard: string;
  origin: string;
  name?: string;
  description?: string;
  transport: 'http' | 'webmcp';
  trust: TrustSignal[];
  status: 'valid' | 'invalid';
  reason?: string;
  suggestion?: string;
  discoveredAt: string;
}

export interface TrustSignal {
  type: string;
  detail: string;
}

export interface InboxData {
  candidates: Candidate[];
}
