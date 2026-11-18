export function upload(file) {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.send(file);
}

export function remove(id) {
  return jQuery.ajax({ url: "/api/items", method: "DELETE" });
}

export function readConfig(store) {
  return store.open("notes.txt", "r");
}
