import * as React from "react"

const VIEWPORT_MARGIN = 8
const INTERACTIVE_SELECTOR =
  "button, input, textarea, select, a, [contenteditable=true]"

interface DragState {
  pointerId: number
  startX: number
  startY: number
  startLeft: number
  startTop: number
  width: number
  height: number
}

type PointerHandlers = Pick<
  React.DOMAttributes<HTMLElement>,
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onLostPointerCapture"
>

export function useDraggableDialog(
  headerSlot: string,
  handlers: PointerHandlers = {}
) {
  const [position, setPosition] = React.useState<{
    left: number
    top: number
  } | null>(null)
  const dragState = React.useRef<DragState | null>(null)

  function onPointerDown(event: React.PointerEvent<HTMLElement>) {
    handlers.onPointerDown?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0 || !event.isPrimary) return

    const target = event.target as Element
    const header = target.closest(`[data-slot="${headerSlot}"]`)
    if (!header || target.closest(INTERACTIVE_SELECTOR)) return

    const rect = event.currentTarget.getBoundingClientRect()
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
      height: rect.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: React.PointerEvent<HTMLElement>) {
    handlers.onPointerMove?.(event)
    const drag = dragState.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const maxLeft = Math.max(
      VIEWPORT_MARGIN,
      window.innerWidth - drag.width - VIEWPORT_MARGIN
    )
    const maxTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - drag.height - VIEWPORT_MARGIN
    )

    setPosition({
      left: Math.min(
        maxLeft,
        Math.max(
          VIEWPORT_MARGIN,
          drag.startLeft + event.clientX - drag.startX
        )
      ),
      top: Math.min(
        maxTop,
        Math.max(
          VIEWPORT_MARGIN,
          drag.startTop + event.clientY - drag.startY
        )
      ),
    })
  }

  function stopDragging(
    event: React.PointerEvent<HTMLElement>,
    handler?: React.PointerEventHandler<HTMLElement>
  ) {
    handler?.(event)
    if (dragState.current?.pointerId === event.pointerId) {
      dragState.current = null
    }
  }

  return {
    draggableStyle: position
      ? ({
          left: position.left,
          top: position.top,
          translate: "none",
        } satisfies React.CSSProperties)
      : undefined,
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: React.PointerEvent<HTMLElement>) =>
        stopDragging(event, handlers.onPointerUp),
      onPointerCancel: (event: React.PointerEvent<HTMLElement>) =>
        stopDragging(event, handlers.onPointerCancel),
      onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) =>
        stopDragging(event, handlers.onLostPointerCapture),
    },
  }
}
