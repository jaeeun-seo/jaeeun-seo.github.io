---
layout: default
---

<h1> About Me </h1>
{{ site.mydescription }}


Email: [{{ site.email }}](mailto:{{ site.email }})  
My CV is available <a href="{{ site.CV_file }}" target="_blank">here</a>.

<!-- ───────────────────────── Working Papers ───────────────────────── -->
<section>
  <h2>Working Papers</h2>
  {% assign working = site.data.papers | where: "type", "WP" %}
  {% for p in working %}
    <div class="WP">
      <span class="semi-bold">{{ p.title }}</span>
      {%- if p.authors and p.authors.size > 0 -%}
        <span class="font-small">, with
        {% for a in p.authors %}
          {%- if a.url and a.url != "" -%}
            <a href="{{ a.url }}" class="author" target="_blank">{{ a.name }}</a>
          {%- else -%}
            {{ a.name }}
          {%- endif -%}
          {%- unless forloop.last %} and {% endunless -%}
        {%- endfor -%}
        </span>
      {%- endif %}<br>
      {% if p.detail %}
        <span class="detail">
          {{ p.detail }}
        </span>
      {% endif %}
      <span>
        {% if p.paper %}
          <a href="{{ p.paper }}" class="file" target="_blank">[paper]</a>
        {% endif %}
        {% if p.code %}
          •&nbsp;<a href="{{ p.code }}" class="file" target="_blank">[code]</a>
        {% endif %}
      </span>
    </div>
  {% endfor %}
</section>

<!-- ───────────────────────── Work in Progress ───────────────────────── -->
<section>
  <h2>Work in Progress</h2>
  {% assign working = site.data.papers | where: "type", "WIP" %}
  {% for p in working %}
    <div class="WIP">
      <span class="semi-bold">{{ p.title }}</span>
      {%- if p.authors and p.authors.size > 0 -%}
        <span class="font-small">, with
        {% for a in p.authors %}
          {%- if a.url and a.url != "" -%}
            <a href="{{ a.url }}" class="author" target="_blank">{{ a.name }}</a>
          {%- else -%}
            {{ a.name }}
          {%- endif -%}
          {%- unless forloop.last %} and {% endunless -%}
        {%- endfor -%}
   	</span>
      {%- endif %}<br>
      {% if p.detail %}
        <span class="detail">
          {{ p.detail }}
        </span>
      {% endif %}
      <span>
        {% if p.paper %}
          <a href="{{ p.paper }}" class="file" target="_blank">[paper]</a>
        {% endif %}
        {% if p.code %}
          •&nbsp;<a href="{{ p.code }}" class="file" target="_blank">[code]</a>
        {% endif %}
      </span>
    </div>
  {% endfor %}
</section>
