import { X } from "lucide-react"
import { useEffect, useId, useRef } from "react"

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

export function Modal({ title, children, onClose }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const closeButtonRef = useRef(null)
  const previousFocusRef = useRef(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const body = document.body

    previousFocusRef.current = document.activeElement
    body.classList.add("modal-open")

    const focusFrame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true })
    })

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== "Tab") return

      const focusableElements = Array.from(
        dialogRef.current?.querySelectorAll(focusableSelector) ?? [],
      )

      if (focusableElements.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus({ preventScroll: true })
        return
      }

      const firstElement = focusableElements[0]
      const lastElement = focusableElements.at(-1)
      const activeElement = document.activeElement

      if (!dialogRef.current?.contains(activeElement)) {
        event.preventDefault()
        const nextElement = event.shiftKey ? lastElement : firstElement
        nextElement.focus()
        return
      }

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault()
        lastElement.focus()
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault()
        firstElement.focus()
      }
    }

    document.addEventListener("keydown", handleKeyDown)

    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener("keydown", handleKeyDown)
      body.classList.remove("modal-open")

      if (previousFocusRef.current instanceof HTMLElement && previousFocusRef.current.isConnected) {
        previousFocusRef.current.focus({ preventScroll: true })
      }
    }
  }, [])

  const closeFromBackdrop = (event) => {
    if (event.target === event.currentTarget) onClose()
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <section
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <button
          ref={closeButtonRef}
          className="icon-button modal__close"
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} aria-hidden="true" />
        </button>
        <h2 id={titleId}>{title}</h2>
        {children}
      </section>
    </div>
  )
}
