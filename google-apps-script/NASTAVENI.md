# Nastavení Google Apps Scriptu V15

1. Otevři Google Tabulku s objednávkami.
2. Zvol **Rozšíření → Apps Script**.
3. Nahraď celý obsah souboru `Code.gs` obsahem souboru `google-apps-script/Code.gs` z tohoto balíčku.
4. Kód ulož.
5. Funkci `setup` spusť pouze tehdy, pokud ještě nebyla spuštěna nebo chceš doplnit chybějící listy a nastavení. Existující objednávky, produkty ani heslo nemaže.
6. Otevři **Nasadit → Spravovat implementace**.
7. U aktivní webové aplikace klikni na tužku, vyber **Nová verze** a klikni na **Implementovat**.
8. Přístup musí zůstat nastavený na **Kdokoli**.

Pouhé uložení `Code.gs` nestačí. Aby se opravy projevily na webu, musí být vytvořena nová verze implementace.
