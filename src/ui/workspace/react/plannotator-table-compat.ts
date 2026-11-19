// Plannotator uses the v8 table API. TanStack v9 keeps it in the legacy entrypoint.
export {
    legacyCreateColumnHelper as createColumnHelper,
    useLegacyTable as useReactTable,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type LegacyColumnDef as ColumnDef,
} from "@tanstack/react-table/legacy";
export { flexRender } from "@tanstack/react-table/flex-render";
import type { getDefaultSortingState } from "@tanstack/react-table/static-functions";

export type SortingState = ReturnType<typeof getDefaultSortingState>;
