import { useEffect, useRef, useState } from "react";

/** Start closed and reveal the first annotation once; later edits respect manual collapse. */
export function useReviewAnnotations(annotationCount: number) {
    const [open, setOpen] = useState(false);
    const revealed = useRef(false);
    useEffect(() => {
        if (annotationCount === 0 || revealed.current) return;
        revealed.current = true;
        setOpen(true);
    }, [annotationCount]);
    return [open, setOpen] as const;
}
