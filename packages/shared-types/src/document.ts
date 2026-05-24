// Document type shared across agent and web

export interface Document {
  id: string;
  tenantId: string;
  clientId: string;
  type: 'invoice' | 'offer';
  filePath: string;
  fileUrl: string;
  status: 'draft' | 'approved' | 'sent';
  createdAt: string;
  sentAt?: string;
  approvedAt?: string;
}
