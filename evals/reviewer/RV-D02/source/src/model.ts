export interface ReceiptSettings {
    shop: string;
}
export interface Invoice {
    number: string;
    items: InvoiceItem[];
}
export interface InvoiceItem {
    label: string;
    cents: number;
}
