// Bonk Brawl client entry. Owner: client-app.
import "./ui/ui.css";
import { App } from "./app/App";

const gameRoot = document.getElementById("game");
const uiRoot = document.getElementById("ui");
if (!gameRoot || !uiRoot) throw new Error("Bonk Brawl: missing #game or #ui root");

const app = new App(gameRoot, uiRoot);
void app.start();
