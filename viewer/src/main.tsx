import { render } from "solid-js/web";
import App from "./App.tsx";
import "./styles.css";

render(() => <App />, document.body);

if ("serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register("/sw.js");
}
