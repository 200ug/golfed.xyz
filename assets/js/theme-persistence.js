if (localStorage.getItem("theme") === "light") {
  document.documentElement.setAttribute("data-theme", "light")
}

document.addEventListener("DOMContentLoaded", () => {
  const checkbox = document.getElementById("theme-toggle")
  checkbox.checked = document.documentElement.getAttribute("data-theme") === "light"
  checkbox?.addEventListener("change", () => {
    localStorage.setItem("theme", checkbox.checked ? "light" : "dark")
    document.documentElement.setAttribute("data-theme", checkbox.checked ? "light" : "dark")
  })
})
