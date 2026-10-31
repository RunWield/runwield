export interface Accession {
    accession: string;
    title: string;
}
export interface AccessionPage {
    items: Accession[];
    nextCursor?: string;
}
