--
-- PostgreSQL database dump
--

\restrict l03gaUYmOH7Bi1g6jvhbIPOPLsktEGcR9549xzcZhmba93cpCfdhU6rwyPfKwWv

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Ubuntu 17.11-1.pgdg24.04+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: familias_motor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.familias_motor (
    id bigint NOT NULL,
    codigo_motor text NOT NULL,
    descripcion text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE familias_motor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.familias_motor IS 'Familias de motor por código técnico — el mismo motor se reutiliza en muchos modelos comerciales distintos, y varios fabricantes lo usan.';


--
-- Name: familias_motor_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.familias_motor ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.familias_motor_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: modelo_motor_nexo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modelo_motor_nexo (
    modelo_comercial_id bigint NOT NULL,
    familia_motor_id bigint NOT NULL
);


--
-- Name: TABLE modelo_motor_nexo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.modelo_motor_nexo IS 'Vínculo muchos-a-muchos entre modelo comercial y familia de motor. Este es el corazón de la compatibilidad cruzada: buscar por acá resuelve "qué otros modelos llevan el mismo motor que el mío".';


--
-- Name: modelos_comerciales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modelos_comerciales (
    id bigint NOT NULL,
    marca text NOT NULL,
    modelo text NOT NULL,
    anio_desde smallint,
    anio_hasta smallint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT modelos_comerciales_anio_valido CHECK (((anio_hasta IS NULL) OR (anio_hasta >= anio_desde)))
);


--
-- Name: TABLE modelos_comerciales; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.modelos_comerciales IS 'Modelos comerciales tal como los reconoce el cliente (marca + modelo + rango de años), independiente del motor que lleven.';


--
-- Name: modelos_comerciales_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.modelos_comerciales ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.modelos_comerciales_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: repuesto_compatibilidad_modelo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repuesto_compatibilidad_modelo (
    codprod text NOT NULL,
    modelo_comercial_id bigint NOT NULL
);


--
-- Name: repuesto_compatibilidad_motor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repuesto_compatibilidad_motor (
    codprod text NOT NULL,
    familia_motor_id bigint NOT NULL
);


--
-- Name: sinonimos_busqueda; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sinonimos_busqueda (
    id bigint NOT NULL,
    termino_jerga text NOT NULL,
    termino_catalogo text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE sinonimos_busqueda; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sinonimos_busqueda IS 'Jerga/sinónimos venezolanos -> término real usado en saprod.descrip. Se consulta en cada búsqueda, sin necesidad de redesplegar la función al agregar uno nuevo.';


--
-- Name: sinonimos_busqueda_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sinonimos_busqueda ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.sinonimos_busqueda_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: familias_motor familias_motor_codigo_motor_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.familias_motor
    ADD CONSTRAINT familias_motor_codigo_motor_key UNIQUE (codigo_motor);


--
-- Name: familias_motor familias_motor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.familias_motor
    ADD CONSTRAINT familias_motor_pkey PRIMARY KEY (id);


--
-- Name: modelo_motor_nexo modelo_motor_nexo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modelo_motor_nexo
    ADD CONSTRAINT modelo_motor_nexo_pkey PRIMARY KEY (modelo_comercial_id, familia_motor_id);


--
-- Name: modelos_comerciales modelos_comerciales_marca_modelo_anio_desde_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modelos_comerciales
    ADD CONSTRAINT modelos_comerciales_marca_modelo_anio_desde_key UNIQUE (marca, modelo, anio_desde);


--
-- Name: modelos_comerciales modelos_comerciales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modelos_comerciales
    ADD CONSTRAINT modelos_comerciales_pkey PRIMARY KEY (id);


--
-- Name: repuesto_compatibilidad_modelo repuesto_compatibilidad_modelo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repuesto_compatibilidad_modelo
    ADD CONSTRAINT repuesto_compatibilidad_modelo_pkey PRIMARY KEY (codprod, modelo_comercial_id);


--
-- Name: repuesto_compatibilidad_motor repuesto_compatibilidad_motor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repuesto_compatibilidad_motor
    ADD CONSTRAINT repuesto_compatibilidad_motor_pkey PRIMARY KEY (codprod, familia_motor_id);


--
-- Name: sinonimos_busqueda sinonimos_busqueda_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sinonimos_busqueda
    ADD CONSTRAINT sinonimos_busqueda_pkey PRIMARY KEY (id);


--
-- Name: sinonimos_busqueda sinonimos_busqueda_termino_jerga_termino_catalogo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sinonimos_busqueda
    ADD CONSTRAINT sinonimos_busqueda_termino_jerga_termino_catalogo_key UNIQUE (termino_jerga, termino_catalogo);


--
-- Name: idx_modelos_comerciales_marca_modelo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_modelos_comerciales_marca_modelo ON public.modelos_comerciales USING btree (marca, modelo);


--
-- Name: idx_repuesto_compat_modelo_modelo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repuesto_compat_modelo_modelo ON public.repuesto_compatibilidad_modelo USING btree (modelo_comercial_id);


--
-- Name: idx_repuesto_compat_motor_familia; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repuesto_compat_motor_familia ON public.repuesto_compatibilidad_motor USING btree (familia_motor_id);


--
-- Name: modelo_motor_nexo modelo_motor_nexo_familia_motor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modelo_motor_nexo
    ADD CONSTRAINT modelo_motor_nexo_familia_motor_id_fkey FOREIGN KEY (familia_motor_id) REFERENCES public.familias_motor(id) ON DELETE CASCADE;


--
-- Name: modelo_motor_nexo modelo_motor_nexo_modelo_comercial_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modelo_motor_nexo
    ADD CONSTRAINT modelo_motor_nexo_modelo_comercial_id_fkey FOREIGN KEY (modelo_comercial_id) REFERENCES public.modelos_comerciales(id) ON DELETE CASCADE;


--
-- Name: repuesto_compatibilidad_modelo repuesto_compatibilidad_modelo_codprod_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repuesto_compatibilidad_modelo
    ADD CONSTRAINT repuesto_compatibilidad_modelo_codprod_fkey FOREIGN KEY (codprod) REFERENCES public.repuestos(codprod) ON DELETE CASCADE;


--
-- Name: repuesto_compatibilidad_modelo repuesto_compatibilidad_modelo_modelo_comercial_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repuesto_compatibilidad_modelo
    ADD CONSTRAINT repuesto_compatibilidad_modelo_modelo_comercial_id_fkey FOREIGN KEY (modelo_comercial_id) REFERENCES public.modelos_comerciales(id) ON DELETE CASCADE;


--
-- Name: repuesto_compatibilidad_motor repuesto_compatibilidad_motor_codprod_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repuesto_compatibilidad_motor
    ADD CONSTRAINT repuesto_compatibilidad_motor_codprod_fkey FOREIGN KEY (codprod) REFERENCES public.repuestos(codprod) ON DELETE CASCADE;


--
-- Name: repuesto_compatibilidad_motor repuesto_compatibilidad_motor_familia_motor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repuesto_compatibilidad_motor
    ADD CONSTRAINT repuesto_compatibilidad_motor_familia_motor_id_fkey FOREIGN KEY (familia_motor_id) REFERENCES public.familias_motor(id) ON DELETE CASCADE;


--
-- Name: familias_motor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.familias_motor ENABLE ROW LEVEL SECURITY;

--
-- Name: modelo_motor_nexo; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modelo_motor_nexo ENABLE ROW LEVEL SECURITY;

--
-- Name: modelos_comerciales; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modelos_comerciales ENABLE ROW LEVEL SECURITY;

--
-- Name: familias_motor n8n_catalogo_ro_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY n8n_catalogo_ro_select ON public.familias_motor FOR SELECT TO n8n_catalogo_ro USING (true);


--
-- Name: modelo_motor_nexo n8n_catalogo_ro_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY n8n_catalogo_ro_select ON public.modelo_motor_nexo FOR SELECT TO n8n_catalogo_ro USING (true);


--
-- Name: modelos_comerciales n8n_catalogo_ro_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY n8n_catalogo_ro_select ON public.modelos_comerciales FOR SELECT TO n8n_catalogo_ro USING (true);


--
-- Name: repuesto_compatibilidad_modelo n8n_catalogo_ro_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY n8n_catalogo_ro_select ON public.repuesto_compatibilidad_modelo FOR SELECT TO n8n_catalogo_ro USING (true);


--
-- Name: repuesto_compatibilidad_motor n8n_catalogo_ro_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY n8n_catalogo_ro_select ON public.repuesto_compatibilidad_motor FOR SELECT TO n8n_catalogo_ro USING (true);


--
-- Name: sinonimos_busqueda n8n_catalogo_ro_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY n8n_catalogo_ro_select ON public.sinonimos_busqueda FOR SELECT TO n8n_catalogo_ro USING (true);


--
-- Name: repuesto_compatibilidad_modelo; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.repuesto_compatibilidad_modelo ENABLE ROW LEVEL SECURITY;

--
-- Name: repuesto_compatibilidad_motor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.repuesto_compatibilidad_motor ENABLE ROW LEVEL SECURITY;

--
-- Name: sinonimos_busqueda; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sinonimos_busqueda ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict l03gaUYmOH7Bi1g6jvhbIPOPLsktEGcR9549xzcZhmba93cpCfdhU6rwyPfKwWv