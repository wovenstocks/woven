import { useEffect, useRef, useState } from "react"

export function Reveal({ as: Component = "div", className = "", delay = 0, children, ...props }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(
    () => typeof window === "undefined" || !("IntersectionObserver" in window),
  )

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined

    if (visible || !("IntersectionObserver" in window)) return undefined

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setVisible(true)
        observer.disconnect()
      },
      { rootMargin: "0px 0px -8%", threshold: 0.12 },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [visible])

  return (
    <Component
      ref={ref}
      className={`reveal ${visible ? "reveal--visible" : ""} ${delay ? `reveal--delay-${delay}` : ""} ${className}`.trim()}
      {...props}
    >
      {children}
    </Component>
  )
}
